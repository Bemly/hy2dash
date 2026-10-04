package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

var (
	cfg     *Config
	store   *Store
	col     *Collector
	limiter = newLoginLimiter()
)

// httpsRedirect 只对「经 Cloudflare 且浏览器用的是 http」的请求跳转 https。
// Flexible 模式下 CF 回源永远是 HTTP，所以不能看连接本身是否 TLS，必须看
// X-Forwarded-Proto（它反映浏览器→CF 那一跳），否则会无限跳转。
func httpsRedirect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		xfp := r.Header.Get("X-Forwarded-Proto")
		if i := strings.IndexByte(xfp, ','); i > 0 {
			xfp = xfp[:i]
		}
		if xfp != "" && !strings.EqualFold(strings.TrimSpace(xfp), "https") {
			host := strings.TrimSuffix(r.Host, ":80")
			http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func authed(r *http.Request) bool {
	c, err := r.Cookie("hy2dash_session")
	if err != nil {
		return false
	}
	return cfg.VerifySession(c.Value)
}

func requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authed(r) {
			errJSON(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("CF-Connecting-IP"); v != "" {
		return v
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	host, _, err := splitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func splitHostPort(s string) (string, string, error) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return s, "", nil
	}
	return s[:i], s[i+1:], nil
}

// ---- 简易登录限速 ----
type loginLimiter struct {
	mu   sync.Mutex
	hits map[string][]int64
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{hits: make(map[string][]int64)} }

func (l *loginLimiter) allow(ip string) bool {
	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now - 300
	arr := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if t > cut {
			arr = append(arr, t)
		}
	}
	l.hits[ip] = arr
	if len(arr) >= 12 {
		return false
	}
	l.hits[ip] = append(l.hits[ip], now)
	if len(l.hits) > 4096 { // 防内存膨胀
		l.hits = map[string][]int64{ip: l.hits[ip]}
	}
	return true
}

func main() {
	var confPath string
	flag.StringVar(&confPath, "c", "/etc/hy2dash/config.json", "配置文件路径")
	flag.Parse()

	// 低内存调优：更激进的 GC + 软内存上限
	debug.SetGCPercent(25)
	debug.SetMemoryLimit(24 << 20)
	if os.Getenv("HY2DASH_GOMAXPROCS") == "1" {
		runtime.GOMAXPROCS(1)
	}

	var err error
	var firstRun bool
	var genUser, genPass string
	cfg, firstRun, genUser, genPass, err = LoadConfig(confPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}
	if firstRun {
		// 首次运行：把随机生成的账号密码打到终端（journal 也能看到）
		fmt.Println("==========================================================")
		fmt.Println(" hy2dash 首次启动，已随机生成管理员凭据（请立即保存）")
		fmt.Println("----------------------------------------------------------")
		fmt.Printf("   用户名: %s\n", genUser)
		fmt.Printf("   密  码: %s\n", genPass)
		fmt.Println("----------------------------------------------------------")
		fmt.Printf(" 凭据以「盐 + PBKDF2-SHA256(%d 轮)」形式存于: %s\n", cfg.PassIter, confPath)
		fmt.Println(" 如需修改：登录后台 → 右上角「修改密码」")
		fmt.Println("==========================================================")
		fmt.Println("提示：journalctl -u hy2dash --no-pager | head -40  可再次查看")
	}

	store, err = NewStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("初始化存储失败: %v", err)
	}
	col = NewCollector(cfg, store)
	go col.Run()
	go func() {
		for {
			time.Sleep(5 * time.Second)
			store.Flush()
		}
	}()
	// 定期把已释放的内存还给操作系统，压低 RSS（小机友好）
	go func() {
		t := time.NewTicker(90 * time.Second)
		defer t.Stop()
		for range t.C {
			debug.FreeOSMemory()
		}
	}()

	static, _ := fs.Sub(webFS, "web")

	// 所有路由挂在 base_path 之下（例如 /dash），便于藏在子路径后面
	base := strings.TrimRight(cfg.BasePath, "/")
	if base != "" && !strings.HasPrefix(base, "/") {
		base = "/" + base
	}

	mux := http.NewServeMux()

	// 静态资源
	mux.HandleFunc(base+"/static/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, base+"/static/")
		if strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(static, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		switch {
		case strings.HasSuffix(name, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case strings.HasSuffix(name, ".js"):
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(b)
	})

	// 页面
	servePage := func(file string) http.HandlerFunc {
		body, _ := fs.ReadFile(static, file)
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Write(body)
		}
	}
	mux.HandleFunc(base+"/login", func(w http.ResponseWriter, r *http.Request) {
		if authed(r) {
			http.Redirect(w, r, base+"/", http.StatusFound)
			return
		}
		servePage("login.html")(w, r)
	})
	mux.HandleFunc(base+"/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != base+"/" {
			http.NotFound(w, r)
			return
		}
		if !authed(r) {
			http.Redirect(w, r, base+"/login", http.StatusFound)
			return
		}
		servePage("index.html")(w, r)
	})
	if base != "" {
		// /dash -> /dash/ （保证相对资源路径正确解析）
		mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, base+"/", http.StatusFound)
		})
	}

	// 认证
	mux.HandleFunc(base+"/api/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		ip := clientIP(r)
		if !limiter.allow(ip) {
			errJSON(w, http.StatusTooManyRequests, "尝试过于频繁，请 5 分钟后再试")
			return
		}
		var in struct {
			User string `json:"user"`
			Pass string `json:"pass"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		if !cfg.CheckPassword(strings.TrimSpace(in.User), in.Pass) {
			errJSON(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "hy2dash_session",
			Value:    cfg.SignSession(12 * time.Hour),
			Path:     base + "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   r.Header.Get("X-Forwarded-Proto") == "https",
			MaxAge:   12 * 3600,
		})
		writeJSON(w, 200, map[string]any{"ok": true, "user": cfg.AdminUser})
	})

	mux.HandleFunc(base+"/api/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "hy2dash_session", Value: "", Path: base + "/", MaxAge: -1})
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc(base+"/api/me", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"user": cfg.AdminUser})
	}))

	mux.HandleFunc(base+"/api/password", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var in struct {
			Old string `json:"old"`
			New string `json:"new"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		if !cfg.CheckPassword(cfg.AdminUser, in.Old) {
			errJSON(w, http.StatusUnauthorized, "原密码错误")
			return
		}
		if len(in.New) < 8 {
			errJSON(w, http.StatusBadRequest, "新密码至少 8 位")
			return
		}
		cfg.SetPassword(in.New)
		if err := cfg.Save(flag.Lookup("c").Value.String()); err != nil {
			errJSON(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: "hy2dash_session", Value: cfg.SignSession(12 * time.Hour), Path: base + "/",
			HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 12 * 3600,
		})
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))

	// 数据接口
	mux.HandleFunc(base+"/api/live", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, col.Snapshot())
	}))
	mux.HandleFunc(base+"/api/recent", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if n <= 0 || n > ringCap {
			n = 100
		}
		writeJSON(w, 200, map[string]any{"recent": store.Recent(n)})
	}))
	mux.HandleFunc(base+"/api/history", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		day := q.Get("date")
		if day == "" {
			day = time.Now().Format("2006-01-02")
		}
		if _, err := time.Parse("2006-01-02", day); err != nil {
			errJSON(w, http.StatusBadRequest, "date 格式应为 YYYY-MM-DD")
			return
		}
		limit, _ := strconv.Atoi(q.Get("limit"))
		offset, _ := strconv.Atoi(q.Get("offset"))
		rows, total, err := store.History(day, q.Get("q"), limit, offset)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"date": day, "total": total, "rows": rows})
	}))
	mux.HandleFunc(base+"/api/summary", requireAuth(func(w http.ResponseWriter, r *http.Request) {
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		if days <= 0 || days > 90 {
			days = 7
		}
		writeJSON(w, 200, store.Summary(days))
	}))
	mux.HandleFunc(base+"/api/health", func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		writeJSON(w, 200, map[string]any{
			"ok": true, "rss_kb": readRSSKB(), "sys_kb": m.Sys / 1024,
			"heap_kb": m.HeapAlloc / 1024, "goroutines": runtime.NumGoroutine(),
		})
	})

	handler := httpsRedirect(mux)

	newSrv := func(addr string) *http.Server {
		return &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
		}
	}

	addrs := []string{cfg.Listen}
	if cfg.PublicListen != "" {
		addrs = append(addrs, cfg.PublicListen)
	}
	for _, a := range addrs {
		srv := newSrv(a)
		go func(srv *http.Server, addr string) {
			log.Printf("hy2dash 监听 %s （base=%q 数据目录 %s）", addr, base, cfg.DataDir)
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("监听 %s 退出: %v", addr, err)
			}
		}(srv, a)
	}
	// 可选：给 Cloudflare Full 模式用的源站 TLS 监听
	if cfg.PublicTLSListen != "" && cfg.TLSCert != "" && cfg.TLSKey != "" {
		srv := newSrv(cfg.PublicTLSListen)
		go func() {
			log.Printf("hy2dash TLS 监听 %s", cfg.PublicTLSListen)
			if err := srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey); err != nil && err != http.ErrServerClosed {
				log.Printf("TLS 监听退出: %v", err)
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	store.Flush()
	log.Println("已停止")
}

// readRSSKB 读真实 RSS（VmRSS），比 runtime.MemStats.Sys 更准确
func readRSSKB() int {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				n, _ := strconv.Atoi(f[1])
				return n
			}
		}
	}
	return 0
}
