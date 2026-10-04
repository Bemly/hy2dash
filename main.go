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
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web sub-template.yaml
var webFS embed.FS

var (
	cfg     *Config
	store   *Store
	col     *Collector
	users   *UserStore
	limiter = newLoginLimiter()
	subTpl  string
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

// session 返回当前会话的角色与用户名（v1 会话；旧格式一律失效）
func session(r *http.Request) (role, name string, ok bool) {
	c, err := r.Cookie("hy2dash_session")
	if err != nil {
		return "", "", false
	}
	role, name, ok = cfg.VerifySession(c.Value)
	if !ok {
		return "", "", false
	}
	if role == "user" {
		users.mu.Lock()
		u, exists := users.byID[name]
		users.mu.Unlock()
		if !exists || !u.Enabled {
			return "", "", false
		}
	}
	return role, name, true
}

func requireLogin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := session(r); !ok {
			errJSON(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func requireAdmin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role, _, ok := session(r)
		if !ok || role != "admin" {
			errJSON(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

func setSession(w http.ResponseWriter, r *http.Request, base, role, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "hy2dash_session",
		Value:    cfg.SignSession(role, name, 12*time.Hour),
		Path:     base + "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.Header.Get("X-Forwarded-Proto") == "https",
		MaxAge:   12 * 3600,
	})
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

// isSubToken 订阅 token 形状：32 位 hex（randToken(16)）
func isSubToken(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

var validBasePath = regexp.MustCompile(`^/[A-Za-z0-9_\-/]{1,64}$`)

// ---- 简易登录/注册限速 ----
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
		// 首次运行：把随机生成的管理员凭据打到终端（journal 也能看到）
		fmt.Println("==========================================================")
		fmt.Println(" hy2dash 首次启动，已随机生成管理员凭据（请立即保存）")
		fmt.Println("----------------------------------------------------------")
		fmt.Printf("   用户名: %s\n", genUser)
		fmt.Printf("   密  码: %s\n", genPass)
		fmt.Println("----------------------------------------------------------")
		fmt.Printf(" 凭据以「盐 + PBKDF2-SHA256(%d 轮)」形式存于: %s\n", cfg.PassIter, confPath)
		fmt.Println("==========================================================")
	}

	users, err = NewUserStore(cfg.UserFile())
	if err != nil {
		log.Fatalf("初始化用户库失败: %v", err)
	}
	subTpl = loadSubTemplate(confPath)

	store, err = NewStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("初始化存储失败: %v", err)
	}
	col = NewCollector(cfg, store)
	go col.Run()
	go runUsageSampler(users, col)
	go runKickWatchdog(users, cfg)
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

	webRoot, _ := fs.Sub(webFS, "web")

	// 所有路由挂在 base_path 之下（例如 /dash），便于藏在子路径后面
	base := strings.TrimRight(cfg.BasePath, "/")
	if base != "" && !strings.HasPrefix(base, "/") {
		base = "/" + base
	}

	mux := http.NewServeMux()

	serveFile := func(name, ctype string) http.HandlerFunc {
		body, _ := fs.ReadFile(webRoot, name)
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", ctype)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Write(body)
		}
	}

	// 静态资源（app.js / style.css）
	mux.HandleFunc(base+"/static/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, base+"/static/")
		if strings.Contains(name, "..") || strings.Contains(name, "/") {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(webRoot, name)
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

	// 页面：登录 / 应用（应用内按角色渲染；注册已并入 Steam 登录）
	mux.HandleFunc(base+"/login", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := session(r); ok {
			http.Redirect(w, r, base+"/", http.StatusFound)
			return
		}
		serveFile("login.html", "text/html; charset=utf-8")(w, r)
	})
	// 旧注册页：已废弃，统一跳登录（Steam 按钮在登录页）
	mux.HandleFunc(base+"/register", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, base+"/login", http.StatusFound)
	})
	if base != "" {
		// /dash -> /dash/ （保证相对资源路径正确解析）
		mux.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, base+"/", http.StatusFound)
		})
	}

	// ---- 认证：管理员走密码，用户走 Steam（唯一入口） ----
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
		name := strings.TrimSpace(in.User)
		if !cfg.CheckPassword(name, in.Pass) {
			errJSON(w, http.StatusUnauthorized, "用户名或密码错误")
			return
		}
		setSession(w, r, base, "admin", cfg.AdminUser)
		writeJSON(w, 200, map[string]any{"ok": true, "user": cfg.AdminUser, "role": "admin"})
	})

	// Steam 登录：用户侧唯一入口（首次登录自动注册）
	mux.HandleFunc(base+"/api/steam/login", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:     "hy2dash_oauth",
			Value:    steamState(),
			Path:     base + "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   r.Header.Get("X-Forwarded-Proto") == "https",
			MaxAge:   600,
		})
		http.Redirect(w, r, steamLoginURL(r, base), http.StatusFound)
	})
	mux.HandleFunc(base+"/api/steam/callback", func(w http.ResponseWriter, r *http.Request) {
		fail := func(msg string) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprintf(w, `<p style="font-family:sans-serif;padding:40px">Steam 登录失败：%s。<a href="%s/login">返回</a></p>`, msg, base)
		}
		st, err := r.Cookie("hy2dash_oauth")
		if err != nil || st.Value == "" {
			fail("流程过期，请重试")
			return
		}
		// state 一次性
		http.SetCookie(w, &http.Cookie{Name: "hy2dash_oauth", Value: "", Path: base + "/", MaxAge: -1})
		steamID, ok := steamVerify(r.URL.Query())
		if !ok {
			fail("Steam 验证未通过")
			return
		}
		nick, avatar := steamPersona(steamID)
		u, _, err := users.FindOrCreate(steamID, nick, avatar, cfg.Slots)
		if err != nil {
			fail(err.Error())
			return
		}
		if !u.Enabled {
			fail("账号已停用，请联系管理员")
			return
		}
		setSession(w, r, base, "user", u.Name)
		http.Redirect(w, r, base+"/", http.StatusFound)
	})

	mux.HandleFunc(base+"/api/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "hy2dash_session", Value: "", Path: base + "/", MaxAge: -1})
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc(base+"/api/me", requireLogin(func(w http.ResponseWriter, r *http.Request) {
		role, name, _ := session(r)
		out := map[string]any{"user": name, "role": role}
		if role == "user" {
			users.mu.Lock()
			u := users.byID[name]
			users.mu.Unlock()
			if u != nil {
				out["hy_user"] = u.HyUser
				out["nick"] = u.Nick
				out["avatar"] = u.Avatar
				out["sub_token"] = u.Token
			}
		}
		writeJSON(w, 200, out)
	}))

	// 改密：仅管理员（用户无密码，用 Steam 登录）
	mux.HandleFunc(base+"/api/password", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
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
		if len(in.New) < 8 {
			errJSON(w, http.StatusBadRequest, "新密码至少 8 位")
			return
		}
		role, _, _ := session(r)
		if role == "admin" {
			if !cfg.CheckPassword(cfg.AdminUser, in.Old) {
				errJSON(w, http.StatusUnauthorized, "原密码错误")
				return
			}
			cfg.SetPassword(in.New)
			if err := cfg.Save(flag.Lookup("c").Value.String()); err != nil {
				errJSON(w, http.StatusInternalServerError, "保存失败: "+err.Error())
				return
			}
			setSession(w, r, base, "admin", cfg.AdminUser)
		} else {
			errJSON(w, http.StatusForbidden, "用户请使用 Steam 登录，无密码可改")
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))

	// ---- 管理端：面板设置 ----
	mux.HandleFunc(base+"/api/settings", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"base_path": cfg.BasePath})
	}))
	mux.HandleFunc(base+"/api/base_path", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var in struct {
			Path string `json:"path"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		p := strings.TrimSpace(in.Path)
		p = strings.TrimRight(p, "/")
		if p == "" || !validBasePath.MatchString(p) {
			errJSON(w, http.StatusBadRequest, "路径需以 / 开头，仅字母数字/_/-，如 /iku-iku-o-hohho")
			return
		}
		if p == cfg.BasePath {
			writeJSON(w, 200, map[string]any{"ok": true, "base_path": p, "changed": false})
			return
		}
		cfg.BasePath = p
		if err := cfg.Save(flag.Lookup("c").Value.String()); err != nil {
			errJSON(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "base_path": p, "changed": true})
	}))
	// 保存后调用：刷盘并退出，靠 systemd 重启生效（旧会话 cookie 会失效，需重登）
	mux.HandleFunc(base+"/api/restart", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		store.Flush()
		writeJSON(w, 200, map[string]bool{"ok": true})
		go func() {
			time.Sleep(500 * time.Millisecond)
			os.Exit(0)
		}()
	}))
	// ---- 管理端：用户 ----
	mux.HandleFunc(base+"/api/users", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		now := time.Now()
		today := todayKey()
		type row struct {
			User
			Tx         uint64 `json:"tx"`
			Rx         uint64 `json:"rx"`
			DayUsed    uint64 `json:"day_used"`
			MonUsed    uint64 `json:"mon_used"`
			DailyQuota uint64 `json:"daily_quota"`
			MonQuota   uint64 `json:"mon_quota"`
			State      string `json:"state"`
		}
		users.mu.Lock()
		// 直接读 map（已持有锁，不复用 List 以免重复加锁）
		out := make([]row, 0, len(users.byID))
		for _, u := range users.byID {
			c := *u
			c.Token = ""
			tx, rx := u.monthUpDown(now)
			out = append(out, row{
				User: c, Tx: tx, Rx: rx,
				DayUsed: u.dayUsed(today), MonUsed: u.monthUsed(now),
				DailyQuota: u.dailyQuota(), MonQuota: u.monthlyQuota(),
				State: u.quotaState(today, now),
			})
		}
		users.mu.Unlock()
		writeJSON(w, 200, map[string]any{"users": out, "slots_total": len(cfg.Slots)})
	}))
	mux.HandleFunc(base+"/api/user/quota", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var in struct {
			User    string  `json:"user"`
			Daily   float64 `json:"daily_gb"`
			Monthly float64 `json:"monthly_gb"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		if err := users.SetQuota(in.User, in.Daily, in.Monthly); err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	// 管理端总览：设备总额（HostKer 日同步）vs 用户合计（各订阅用量加总）
	mux.HandleFunc(base+"/api/overview", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		now := time.Now()
		var utx, urx uint64
		users.mu.Lock()
		for _, u := range users.byID {
			tx, rx := u.monthUpDown(now)
			utx += tx
			urx += rx
		}
		users.mu.Unlock()
		dev := hostkerStats(false)
		out := map[string]any{
			"users_tx": utx, "users_rx": urx,
			"device":   dev,
		}
		writeJSON(w, 200, out)
	}))
	mux.HandleFunc(base+"/api/hostker/refresh", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		st := hostkerStats(true)
		if st == nil {
			errJSON(w, http.StatusBadGateway, "HostKer 同步失败（未配置凭据或网络异常）")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "at": st.At, "servers": st.Servers})
	}))
	mux.HandleFunc(base+"/api/user/enable", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			User string `json:"user"`
			On   bool   `json:"on"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		if err := users.SetEnabled(in.User, in.On); err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if !in.On {
			// 停用即踢下线（查 HyUser 再踢）
			users.mu.Lock()
			hy := ""
			if u, ok := users.byID[in.User]; ok {
				hy = u.HyUser
			}
			users.mu.Unlock()
			if hy != "" {
				go kickEverywhere(cfg.HysteriaNodes, hy)
			}
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc(base+"/api/user/delete", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			User string `json:"user"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		users.mu.Lock()
		hy := ""
		if u, ok := users.byID[in.User]; ok {
			hy = u.HyUser
		}
		users.mu.Unlock()
		if err := users.Delete(in.User); err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if hy != "" {
			go kickEverywhere(cfg.HysteriaNodes, hy)
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc(base+"/api/user/rotate", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			User string `json:"user"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			errJSON(w, http.StatusBadRequest, "bad request")
			return
		}
		tok, err := users.RotateToken(in.User)
		if err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		_ = tok // token 只属于用户本人（其面板可见），管理端不回显
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))

	// ---- 用户端：自己的用量与配额 ----
	mux.HandleFunc(base+"/api/my/summary", requireLogin(func(w http.ResponseWriter, r *http.Request) {
		role, name, _ := session(r)
		out := map[string]any{"hy_user": "", "state": "ok"}
		if role == "user" {
			users.mu.Lock()
			u := users.byID[name]
			if u != nil {
				today := todayKey()
				now := time.Now()
				if u.ensureDay(today) {
					users.save()
				}
				tx, rx := u.monthUpDown(now)
				out["hy_user"] = u.HyUser
				out["tx"] = tx
				out["rx"] = rx
				out["day_used"] = u.dayUsed(today)
				out["day_granted"] = u.Granted
				out["mon_used"] = u.monthUsed(now)
				out["daily_quota"] = u.dailyQuota()
				out["monthly_quota"] = u.monthlyQuota()
				out["state"] = u.quotaState(today, now)
			}
			users.mu.Unlock()
		}
		writeJSON(w, 200, out)
	}))
	mux.HandleFunc(base+"/api/my/renew", requireLogin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		role, name, _ := session(r)
		if role != "user" {
			errJSON(w, http.StatusForbidden, "forbidden")
			return
		}
		g, err := users.Renew(name)
		if err != nil {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "granted": g})
	}))

	// ---- 管理端：数据接口 ----
	mux.HandleFunc(base+"/api/live", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, col.Snapshot())
	}))
	mux.HandleFunc(base+"/api/recent", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if n <= 0 || n > ringCap {
			n = 100
		}
		writeJSON(w, 200, map[string]any{"recent": store.Recent(n)})
	}))
	mux.HandleFunc(base+"/api/history", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc(base+"/api/summary", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
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

	// ---- 订阅下发（取代 Worker）：token 认人，只给自己的节点 ----
	// 链接形如 {base}/<token>（无 /sub/ 中间段）；token 为 32 位 hex
	serveSub := func(w http.ResponseWriter, r *http.Request, tok string) {
		u := users.ByToken(tok)
		if u == nil {
			errJSON(w, http.StatusUnauthorized, "invalid token")
			return
		}
		now := time.Now()
		today := todayKey()
		users.mu.Lock()
		if u.ensureDay(today) {
			users.save()
		}
		st := u.quotaState(today, now)
		// 订阅头按天口径：已用=今日用量，总量=今日已授额度（续额后刷新订阅即涨 10G→20G）
		day := u.Buckets[today]
		granted := u.Granted
		users.mu.Unlock()
		// 配额锁：订阅直接拒绝，客户端显示更新失败
		if st == "monthly" {
			errJSON(w, http.StatusForbidden, "本月限额已用完")
			return
		}
		if st == "daily" {
			errJSON(w, http.StatusForbidden, "今日额度用完，请到面板续额")
			return
		}
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Subscription-Userinfo",
			fmt.Sprintf("upload=%d; download=%d; total=%d", day.Tx, day.Rx, granted))
		w.Write([]byte(buildUserYAML(subTpl, u, cfg.Slots, cfg.Servers)))
	}

	mux.HandleFunc(base+"/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == base+"/" {
			if _, _, ok := session(r); !ok {
				http.Redirect(w, r, base+"/login", http.StatusFound)
				return
			}
			serveFile("index.html", "text/html; charset=utf-8")(w, r)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, base+"/")
		if rest != "" && !strings.Contains(rest, "/") && isSubToken(rest) {
			if r.Method != http.MethodGet {
				errJSON(w, http.StatusMethodNotAllowed, "method not allowed")
				return
			}
			serveSub(w, r, rest)
			return
		}
		http.NotFound(w, r)
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
