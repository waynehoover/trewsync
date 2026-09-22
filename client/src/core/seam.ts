/**
 * The pause points, behind one name each, so something can enumerate them.
 *
 * Every destructive path in this client has an instant in it that decides
 * whether an edit survives, and each of those instants has a hook so a test
 * can stop the world inside it. There are nine of them now. They were added
 * one at a time, each by the test for the defect that found it, and each test
 * names its own hook by hand.
 *
 * That is how the same defect kept coming back in a different ordering. A
 * fixed ordering gets a test; the ordering next to it gets nothing, because
 * nobody wrote a test naming that hook. The count of hooks grew and the number
 * of orderings anybody had actually tried stayed at one per hook.
 *
 * So they are registered. A driver can ask for all of them and run the same
 * scenario against each in turn, which is the difference between testing the
 * orderings somebody thought of and testing the ones that exist.
 *
 * `pause` stays a plain writable property, because that is how every existing
 * test uses these and rewriting those was not the point.
 */

/** What runs inside a seam. The path is empty where the seam has no path. */
export type SeamHook = (path: string) => Promise<void> | void;

/**
 * What sits at a seam. Always takes the path, even where the seam has none,
 * so that one driver can drive all of them; those pass the empty string.
 */
export type SeamPause = (path: string) => Promise<void>;

export interface Seam {
  readonly name: string;
  /**
   * Called from inside the operation. Does nothing until something replaces
   * it, which is every build that is not a test.
   */
  pause: SeamPause;
  /**
   * Runs `hook` inside this seam until the returned function is called.
   *
   * Composes with whatever was there, including a test that assigned `pause`
   * directly, because it saves and restores the property rather than a
   * separate slot.
   */
  hold(hook: SeamHook): () => void;
}

const registry = new Map<string, Seam>();

/**
 * Declares a seam and registers it under `name`.
 *
 * The name is what a driver reports when a permutation fails, so it says where
 * rather than which number: "cli/vault:respell.parked" is a place somebody can
 * go and look at.
 */
export function seam(name: string): Seam {
  if (registry.has(name)) throw new Error(`two seams are called ${name}`);
  const it: Seam = {
    name,
    pause: async (): Promise<void> => {},
    hold(hook: SeamHook) {
      const was = it.pause;
      const mine = async (path: string): Promise<void> => {
        await was(path);
        await hook(path);
      };
      it.pause = mine;
      return () => {
        // Only if it is still ours. Two holds released out of order would
        // otherwise put back a hook the inner one had already replaced, and
        // the seam would keep firing a scenario that had finished.
        if (it.pause === mine) it.pause = was;
      };
    },
  };
  registry.set(name, it);
  return it;
}

/**
 * Every seam declared so far, in declaration order.
 *
 * Which is to say: every seam in whatever modules the caller has imported. A
 * driver that wants them all imports the shells it means to exercise, and the
 * count it reports is how anybody notices it is only seeing half of them.
 */
export function seams(): readonly Seam[] {
  return [...registry.values()];
}

/** One seam by name, for a test that means a particular ordering. */
export function seamNamed(name: string): Seam {
  const found = registry.get(name);
  if (found === undefined) {
    throw new Error(`no seam called ${name}; there are ${[...registry.keys()].join(", ")}`);
  }
  return found;
}

/** Puts every seam back to doing nothing. For a test that has finished. */
export function releaseAllSeams(): void {
  for (const it of registry.values()) it.pause = async (): Promise<void> => {};
}

/**
 * Puts several seams behind the properties of one object.
 *
 * The shells expose grouped hooks (`midRespell.parked`) because the call sites
 * read better that way, and sixty tests assign to those properties. Spreading
 * the seams into a literal would copy whatever function was there at the time
 * and leave `hold` writing to an object nobody calls, which is a seam that
 * silently never fires. So these are accessors, and the seam stays the one
 * place the current hook lives.
 */
export function composite<T extends Record<string, Seam>>(parts: T): { [K in keyof T]: SeamPause } {
  const out = {} as Record<string, unknown>;
  for (const [key, it] of Object.entries(parts)) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => it.pause,
      set: (f: SeamPause) => {
        it.pause = f;
      },
    });
  }
  return out as { [K in keyof T]: SeamPause };
}
