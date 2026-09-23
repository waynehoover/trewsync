package notes

import "strings"

// changeLinks resolved and rewrote links with Node's path.posix. Go's path
// package differs from it (Clean drops a trailing slash that normalize keeps,
// and Node resolves relative paths against the working directory), so the
// functions it used are ported here. They only look at "/" and ".", so bytes
// and UTF-16 code units give the same answers.

// posixNormalizeString is Node's normalizeString with "/" as the separator.
func posixNormalizeString(path string, allowAboveRoot bool) string {
	res := ""
	lastSegmentLength := 0
	lastSlash := -1
	dots := 0
	var code byte
	for i := 0; i <= len(path); i++ {
		if i < len(path) {
			code = path[i]
		} else if code == '/' {
			break
		} else {
			code = '/'
		}
		if code == '/' {
			switch {
			case lastSlash == i-1 || dots == 1:
			case dots == 2:
				if len(res) < 2 || lastSegmentLength != 2 || res[len(res)-1] != '.' || res[len(res)-2] != '.' {
					if len(res) > 2 {
						last := strings.LastIndexByte(res, '/')
						if last == -1 {
							res = ""
							lastSegmentLength = 0
						} else {
							res = res[:last]
							lastSegmentLength = len(res) - 1 - strings.LastIndexByte(res, '/')
						}
						lastSlash = i
						dots = 0
						continue
					} else if len(res) != 0 {
						res = ""
						lastSegmentLength = 0
						lastSlash = i
						dots = 0
						continue
					}
				}
				if allowAboveRoot {
					if len(res) > 0 {
						res += "/.."
					} else {
						res = ".."
					}
					lastSegmentLength = 2
				}
			default:
				if len(res) > 0 {
					res += "/" + path[lastSlash+1:i]
				} else {
					res = path[lastSlash+1 : i]
				}
				lastSegmentLength = i - lastSlash - 1
			}
			lastSlash = i
			dots = 0
		} else if code == '.' && dots != -1 {
			dots++
		} else {
			dots = -1
		}
	}
	return res
}

// posixNormalize is path.posix.normalize.
func posixNormalize(path string) string {
	if path == "" {
		return "."
	}
	absolute := path[0] == '/'
	trailing := path[len(path)-1] == '/'
	path = posixNormalizeString(path, !absolute)
	if path == "" {
		if absolute {
			return "/"
		}
		if trailing {
			return "./"
		}
		return "."
	}
	if trailing {
		path += "/"
	}
	if absolute {
		return "/" + path
	}
	return path
}

// posixJoin is path.posix.join.
func posixJoin(parts ...string) string {
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		return "."
	}
	return posixNormalize(strings.Join(kept, "/"))
}

// posixDirname is path.posix.dirname.
func posixDirname(path string) string {
	if path == "" {
		return "."
	}
	root := path[0] == '/'
	end := -1
	matchedSlash := true
	for i := len(path) - 1; i >= 1; i-- {
		if path[i] == '/' {
			if !matchedSlash {
				end = i
				break
			}
		} else {
			matchedSlash = false
		}
	}
	if end == -1 {
		if root {
			return "/"
		}
		return "."
	}
	if root && end == 1 {
		return "//"
	}
	return path[:end]
}

// posixBasename is path.posix.basename without a suffix.
func posixBasename(path string) string {
	start, end := 0, -1
	matchedSlash := true
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			if !matchedSlash {
				start = i + 1
				break
			}
		} else if end == -1 {
			matchedSlash = false
			end = i + 1
		}
	}
	if end == -1 {
		return ""
	}
	return path[start:end]
}

// posixResolve is path.posix.resolve for one path, against a root working
// directory. Node resolves against process.cwd(); changeLinks only ever
// relates two vault paths without "..", for which the working directory
// cancels out.
func posixResolve(path string) string {
	if path == "" || path[0] != '/' {
		path = "/" + path
	}
	return "/" + posixNormalizeString(path, false)
}

// posixRelative is path.posix.relative.
func posixRelative(from, to string) string {
	if from == to {
		return ""
	}
	from, to = posixResolve(from), posixResolve(to)
	if from == to {
		return ""
	}
	fromStart, fromEnd := 1, len(from)
	fromLen := fromEnd - fromStart
	toStart := 1
	toLen := len(to) - toStart
	length := min(fromLen, toLen)
	lastCommonSep := -1
	i := 0
	for ; i < length; i++ {
		c := from[fromStart+i]
		if c != to[toStart+i] {
			break
		} else if c == '/' {
			lastCommonSep = i
		}
	}
	if i == length {
		if toLen > length {
			if to[toStart+i] == '/' {
				return to[toStart+i+1:]
			}
			if i == 0 {
				return to[toStart+i:]
			}
		} else if fromLen > length {
			if from[fromStart+i] == '/' {
				lastCommonSep = i
			} else if i == 0 {
				lastCommonSep = 0
			}
		}
	}
	out := ""
	for i = fromStart + lastCommonSep + 1; i <= fromEnd; i++ {
		if i == fromEnd || from[i] == '/' {
			if out == "" {
				out = ".."
			} else {
				out += "/.."
			}
		}
	}
	return out + to[toStart+lastCommonSep:]
}
