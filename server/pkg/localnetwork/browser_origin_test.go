package localnetwork

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/cors"
)

func TestBrowserOrigins(t *testing.T) {
	for _, tc := range []struct {
		origin  string
		allowed bool
	}{
		{"http://localhost:13534", true}, {"http://127.0.0.1:13534", true}, {"http://[::1]:13534", true},
		{"https://localhost:8443", true}, {"https://example.com", false}, {"http://localhost.evil.example:13534", false},
		{"http://192.168.1.2:13534", false}, {"null", false}, {"file:///tmp/test.html", false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			if got := IsBrowserOrigin(tc.origin); got != tc.allowed {
				t.Fatalf("网页来源校验 = %v，期望 %v", got, tc.allowed)
			}
			h := cors.Handler(cors.Options{AllowedOrigins: BrowserOrigins(), AllowedMethods: []string{"GET"}})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/health", nil)
			req.Header.Set("Origin", tc.origin)
			response := httptest.NewRecorder()
			h.ServeHTTP(response, req)
			if got := response.Header().Get("Access-Control-Allow-Origin"); (got == tc.origin) != tc.allowed {
				t.Fatalf("跨端口访问响应 = %q，期望允许 %v", got, tc.allowed)
			}
		})
	}
}
