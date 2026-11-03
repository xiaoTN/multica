package realtime

import (
	"net/http/httptest"
	"testing"
)

func TestLocalBrowserOrigins(t *testing.T) {
	for _, tc := range []struct {
		origin  string
		allowed bool
	}{
		{"http://localhost:13534", true}, {"http://127.0.0.1:13534", true},
		{"https://[::1]:8443", true}, {"http://localhost.attacker.invalid:13534", false},
		{"https://attacker.invalid", false}, {"http://192.168.1.2:13534", false},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://127.0.0.1:8080/ws", nil)
			req.Header.Set("Origin", tc.origin)
			if got := checkOriginForLocalMode(req, true); got != tc.allowed {
				t.Fatalf("本机网页连接 = %v，期望 %v", got, tc.allowed)
			}
			if checkOriginForLocalMode(req, false) {
				t.Fatal("非本机版本不应额外开放本机开发网页")
			}
		})
	}
}
