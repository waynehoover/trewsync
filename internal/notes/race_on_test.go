//go:build race

package notes

// raceSlowdown scales timing ceilings under the race detector, which runs
// this parsing code several times slower. Measured 2026-11-19: the slowest
// crafted note takes 0.26 s without it and over 2 s with it.
const raceSlowdown = 20
