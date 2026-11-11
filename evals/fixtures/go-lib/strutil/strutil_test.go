package strutil

import "testing"

func TestReverse(t *testing.T) {
	for in, want := range map[string]string{"": "", "abc": "cba", "héllo": "olléh"} {
		if got := Reverse(in); got != want {
			t.Errorf("Reverse(%q) = %q, want %q", in, got, want)
		}
	}
}
