/** Activity for one transfer batch, not a completion receipt for the vault. */
export interface TransferActivity {
  readonly direction: "upload" | "download";
  readonly files: number;
  /** Present only when the batch contains one file. */
  readonly path?: string;
  /** Body bytes on the wire, as frames; excludes reused chunks and metadata. */
  readonly bytes: number;
}

/** A broken display must not interrupt an in-flight protocol exchange. */
export function notifyTransfer<T>(listener: ((value: T) => void) | undefined, value: T): void {
  try {
    listener?.(value);
  } catch {
    // Observational only. Transfer verification and failures have their own path.
  }
}
