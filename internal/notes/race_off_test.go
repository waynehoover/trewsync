//go:build !race

package notes

// raceSlowdown is 1 without the race detector; see race_on_test.go.
const raceSlowdown = 1
