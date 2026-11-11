package semver

import "testing"

func TestHiddenValid(t *testing.T) {
	valid := []string{
		"0.0.0", "1.2.3", "10.20.30", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-0.3.7",
		"1.0.0-x.7.z.92", "1.0.0-x-y-z.--", "1.0.0+20130313144700", "1.0.0-beta+exp.sha.5114f85",
		"1.0.0+21AF26D3---117B344092BD", "1.0.0-alpha0.valid", "1.0.0+001", "1.0.0-0A",
	}
	invalid := []string{
		"", "1", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3+",
		"1.2.3-01", "1.2.3-alpha..1", "1.2.3-al$pha", "-1.2.3", "1.2.3-alpha_beta", " 1.2.3", "1.2.3 ",
		"1.2.-3", "a.b.c", "1.2.3+build..1",
	}
	for _, v := range valid {
		if !Valid(v) {
			t.Errorf("Valid(%q) = false, want true", v)
		}
	}
	for _, v := range invalid {
		if Valid(v) {
			t.Errorf("Valid(%q) = true, want false", v)
		}
	}
}

func TestHiddenPrecedence(t *testing.T) {
	// Each version is lower than the next (SemVer 2.0.0, section 11, plus a few more).
	chain := []string{
		"0.9.9", "1.0.0-0", "1.0.0-1", "1.0.0-2", "1.0.0-10", "1.0.0-Beta", "1.0.0-alpha",
		"1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11",
		"1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "1.9.0", "1.10.0", "2.0.0", "10.0.0",
	}
	for i := 0; i < len(chain)-1; i++ {
		for j := i + 1; j < len(chain); j++ {
			a, b := chain[i], chain[j]
			if got, err := Compare(a, b); err != nil || got != -1 {
				t.Errorf("Compare(%q, %q) = %d, %v; want -1", a, b, got, err)
			}
			if got, err := Compare(b, a); err != nil || got != 1 {
				t.Errorf("Compare(%q, %q) = %d, %v; want 1", b, a, got, err)
			}
		}
	}
}

func TestHiddenEqualAndErrors(t *testing.T) {
	for _, pair := range [][2]string{{"1.0.0", "1.0.0"}, {"1.0.0+a", "1.0.0+b"}, {"1.0.0-rc.1+x", "1.0.0-rc.1"}} {
		if got, err := Compare(pair[0], pair[1]); err != nil || got != 0 {
			t.Errorf("Compare(%q, %q) = %d, %v; want 0", pair[0], pair[1], got, err)
		}
	}
	for _, pair := range [][2]string{{"1.2", "1.0.0"}, {"1.0.0", "v1.0.0"}, {"1.0.0-01", "1.0.0"}} {
		if _, err := Compare(pair[0], pair[1]); err == nil {
			t.Errorf("Compare(%q, %q) returned no error", pair[0], pair[1])
		}
	}
}
