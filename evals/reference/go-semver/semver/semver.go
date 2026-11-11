// Package semver implements Semantic Versioning 2.0.0 validation and precedence.
package semver

import (
	"fmt"
	"strings"
)

type version struct {
	core [3]string
	pre  []string
}

func isNumeric(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func validIdent(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-') {
			return false
		}
	}
	return true
}

func noLeadingZero(s string) bool { return s == "0" || s[0] != '0' }

func parse(v string) (version, error) {
	var out version
	rest := v
	if i := strings.IndexByte(rest, '+'); i >= 0 {
		for _, id := range strings.Split(rest[i+1:], ".") {
			if !validIdent(id) {
				return out, fmt.Errorf("invalid build metadata in %q", v)
			}
		}
		rest = rest[:i]
	}
	if i := strings.IndexByte(rest, '-'); i >= 0 {
		for _, id := range strings.Split(rest[i+1:], ".") {
			if !validIdent(id) || (isNumeric(id) && !noLeadingZero(id)) {
				return out, fmt.Errorf("invalid prerelease in %q", v)
			}
			out.pre = append(out.pre, id)
		}
		rest = rest[:i]
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 {
		return out, fmt.Errorf("invalid version %q", v)
	}
	for i, p := range parts {
		if !isNumeric(p) || !noLeadingZero(p) {
			return out, fmt.Errorf("invalid version %q", v)
		}
		out.core[i] = p
	}
	return out, nil
}

// Valid reports whether v is a valid semantic version.
func Valid(v string) bool {
	_, err := parse(v)
	return err == nil
}

// compareNum compares two numeric strings without leading zeros, of any length.
func compareNum(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

// Compare returns -1, 0 or 1 as a has lower, equal or higher precedence than b.
func Compare(a, b string) (int, error) {
	va, err := parse(a)
	if err != nil {
		return 0, err
	}
	vb, err := parse(b)
	if err != nil {
		return 0, err
	}
	for i := 0; i < 3; i++ {
		if c := compareNum(va.core[i], vb.core[i]); c != 0 {
			return c, nil
		}
	}
	switch {
	case len(va.pre) == 0 && len(vb.pre) == 0:
		return 0, nil
	case len(va.pre) == 0:
		return 1, nil
	case len(vb.pre) == 0:
		return -1, nil
	}
	for i := 0; i < len(va.pre) && i < len(vb.pre); i++ {
		x, y := va.pre[i], vb.pre[i]
		xn, yn := isNumeric(x), isNumeric(y)
		var c int
		switch {
		case xn && yn:
			c = compareNum(x, y)
		case xn:
			c = -1
		case yn:
			c = 1
		default:
			c = strings.Compare(x, y)
		}
		if c != 0 {
			return c, nil
		}
	}
	switch {
	case len(va.pre) < len(vb.pre):
		return -1, nil
	case len(va.pre) > len(vb.pre):
		return 1, nil
	}
	return 0, nil
}
