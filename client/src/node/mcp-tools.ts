import type { CallToolResult, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compareVersions, deliveryStatus } from "./mcp-inspect.ts";
import { LocalMutationError, type Client } from "../core/client.ts";
import { McpHistory, type PreviewInput } from "./mcp-history.ts";
import { type McpReader } from "./mcp-read.ts";
import {
  INPUT_BYTES,
  EDIT_BYTES,
  NOTE_BYTES,
  NoteError,
  mutateNote,
  noteFailure,
  noteFormat,
  noteText,
  type NoteMutation,
} from "./mcp-notes.ts";
import { TrackedMcpServer, MCP_REPLY_BYTES } from "./mcp-protocol.ts";
import type { NodeVault } from "./vault.ts";
import {
  applyOperation,
  previewOperation,
  createDirectory,
  type PlannedChange,
  type VaultOperation,
} from "./mcp-operations.ts";

const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) => !/\p{Surrogate}/u.test(value) && Buffer.byteLength(value) <= bytes,
      "invalid Unicode or byte limit exceeded",
    );
const path = text(4096).min(1);
const base = z.string().regex(/^[a-f0-9]{64}$/u);
const uid = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const limit = (max: number) => z.number().int().min(1).max(max);
const readSchema = z
  .object({
    path,
    uid: uid.optional(),
    startLine: limit(Number.MAX_SAFE_INTEGER).optional(),
    maxLines: limit(1000).optional(),
    base: base.optional(),
  })
  .strict();
const listSchema = z
  .object({
    folder: text(4096).optional(),
    nameContains: text(1024).optional(),
    after: text(8192).optional(),
    limit: limit(500).optional(),
    includeBackups: z.boolean().optional(),
  })
  .strict();
const searchSchema = z
  .object({
    query: text(1024).min(1),
    mode: z.enum(["content", "filename", "both", "tag"]).optional(),
    includeChildren: z.boolean().optional(),
    folder: text(4096).optional(),
    caseSensitive: z.boolean().optional(),
    cursor: text(8192).optional(),
    limit: limit(200).optional(),
    contextLines: z.number().int().min(0).max(3).optional(),
    includeBackups: z.boolean().optional(),
  })
  .strict();
const editSchema = z
  .object({
    path,
    base,
    edits: z
      .array(z.object({ old: text(EDIT_BYTES).min(1), new: text(EDIT_BYTES) }).strict())
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      value.edits.reduce(
        (n, edit) => n + Buffer.byteLength(edit.old) + Buffer.byteLength(edit.new),
        0,
      ) <= INPUT_BYTES,
    "edits exceed 64 KiB",
  );
const appendSchema = z.object({ path, base, text: text(INPUT_BYTES).min(1) }).strict();
const createSchema = z.object({ path, content: text(NOTE_BYTES) }).strict();

const plannedChanges = z
  .array(
    z
      .object({
        path,
        base,
        action: z.enum(["edit", "move", "delete"]),
        to: path.optional(),
        edits: z
          .array(
            z
              .object({
                start: z.number().int().min(0).max(NOTE_BYTES),
                end: z.number().int().min(0).max(NOTE_BYTES),
                old: text(INPUT_BYTES),
                text: text(INPUT_BYTES),
              })
              .strict(),
          )
          .max(4096),
      })
      .strict(),
  )
  .max(32);
const tagFields = {
  paths: z.array(path).min(1).max(32),
  location: z.enum(["frontmatter", "content", "both"]).optional(),
  changes: plannedChanges.optional(),
};
const addFields = {
  ...tagFields,
  tags: z.array(text(200).min(1)).min(1).max(100),
  position: z.enum(["start", "end"]).optional(),
  normalization: z.enum(["preserve", "lowercase", "kebab"]).optional(),
};
const removeFields = {
  ...tagFields,
  tags: z.array(text(200).min(1)).min(1).max(100).optional(),
  patterns: z.array(text(200).min(1)).min(1).max(100).optional(),
  includeChildren: z.boolean().optional(),
};
const addTagsSchema = z.object(addFields).strict();
const removeTagsSchema = z.object(removeFields).strict();
const manageTagsSchema = z.discriminatedUnion("operation", [
  z.object({ ...addFields, operation: z.literal("add") }).strict(),
  z.object({ ...removeFields, operation: z.literal("remove") }).strict(),
]);
const renameTagSchema = z
  .object({
    oldTag: text(200).min(1),
    newTag: text(200).min(1),
    folder: text(4096).optional(),
    includeChildren: z.boolean().optional(),
    location: z.enum(["frontmatter", "content", "both"]).optional(),
    changes: plannedChanges.optional(),
  })
  .strict();
const moveSchema = z
  .object({
    path,
    to: path,
    updateLinks: z.boolean().optional(),
    changes: plannedChanges.optional(),
  })
  .strict();
const deleteSchema = z
  .object({ path, markBroken: z.boolean().optional(), changes: plannedChanges.optional() })
  .strict();
const directorySchema = z.object({ path }).strict();

const historySchema = z
  .object({ path, before: uid.optional(), limit: limit(100).optional() })
  .strict();
const deletedSchema = z.object({ before: uid.optional(), limit: limit(200).optional() }).strict();
const restoreSchema = z.object({ path, uid, to: path }).strict();
const statusSchema = z
  .object({
    preview: z.boolean().optional(),
    after: text(8192).optional(),
    limit: limit(500).optional(),
  })
  .strict()
  .refine(
    (input) => input.preview || (input.after === undefined && input.limit === undefined),
    "after and limit require preview:true",
  );

export interface McpSession {
  readonly mode: "read-only" | "writable";
  readonly reader: McpReader;
  readonly writer: NodeVault;
  client(): Client | undefined;
  stopping(): boolean;
  changed(): void;
  summary(): object;
  status(): Promise<object>;
}

export function toolResult(value: object, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
  // The JSON-RPC id and SDK metadata also need room in the transport's total budget.
  if (Buffer.byteLength(JSON.stringify(result)) > MCP_REPLY_BYTES - 16384) {
    return toolResult(
      { error: { code: "result_too_large", message: "request a smaller page" } },
      true,
    );
  }
  return result;
}
export function toolFailure(error: unknown): { code: string; message: string } {
  if (error instanceof LocalMutationError) return { code: error.code, message: error.message };
  return noteFailure(error);
}

function sessionTools(session: McpSession, register: RegisterTool) {
  const server = { registerTool: register };
  const history = new McpHistory(session.reader, () => session.client());
  const pending = new Set<Promise<CallToolResult>>();
  function call(work: () => Promise<object>): Promise<CallToolResult> {
    const running = (async () => {
      try {
        if (session.stopping()) throw new NoteError("stopping", "the MCP process is stopping");
        const result = await work();
        return toolResult(result, "error" in result);
      } catch (error) {
        return toolResult({ error: toolFailure(error) }, true);
      }
    })();
    pending.add(running);
    void running.finally(() => pending.delete(running));
    return running;
  }
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "list_notes",
    {
      description:
        "List local vault paths. Follow nextAfter for more; backups are hidden unless requested.",
      inputSchema: listSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(await session.reader.list(input, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "read_note",
    {
      description:
        "Read a local or authenticated historical note page with its complete SHA-256 base. Pin base for later pages; a historical base is not a current-version assertion.",
      inputSchema: readSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(input.uid === undefined
          ? await session.reader.read(input, ctx.mcpReq.signal)
          : await history.read({ ...input, uid: input.uid }, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "search_notes",
    {
      description:
        "Search literal content, filenames, both, or parsed Obsidian tags. Follow nextCursor and check skipped and complete.",
      inputSchema: searchSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(await session.reader.search(input, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "sync_status",
    {
      description:
        "Observe connection, readiness, last sync pass and recoverable versions. This is not an upload receipt.",
      inputSchema: statusSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => {
        const status = await session.status();
        if (!input.preview) return status;
        try {
          return {
            ...status,
            preview: await history.preview(input as PreviewInput, ctx.mcpReq.signal),
          };
        } catch (error) {
          return { ...status, previewError: toolFailure(error) };
        }
      }),
  );

  server.registerTool(
    "note_history",
    {
      description:
        "List authenticated versions of one note, newest first. Device names are reported labels, not proof of authorship.",
      inputSchema: historySchema,
      annotations: readAnnotations,
    },
    (input, ctx) => call(() => history.history(input, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "deleted_notes",
    {
      description:
        "List deleted notes still known to the server. Zero restorable versions means no content remains. Follow nextBefore even when policy filters a page.",
      inputSchema: deletedSchema,
      annotations: readAnnotations,
    },
    (input, ctx) => call(() => history.deleted(input, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "compare_versions",
    {
      description:
        "Compare an authenticated historical version with local bytes or another historical version. Paginate with both returned bases. Inspect detailClipped and coarse; read the full versions before acting on omitted detail.",
      inputSchema: z
        .object({
          path,
          fromUid: uid,
          toUid: uid.optional(),
          fromBase: base.optional(),
          toBase: base.optional(),
          after: z.number().int().min(0).max(1_000_000).optional(),
          limit: limit(100).optional(),
        })
        .strict(),
      annotations: readAnnotations,
    },
    (input, ctx) => call(() => compareVersions(history, session.reader, input, ctx.mcpReq.signal)),
  );
  server.registerTool(
    "delivery_status",
    {
      description:
        "Inspect live devices' completed server checkpoints. Offline, unconfirmed or changing local state never proves delivery. This does not confirm a particular edit reached every device.",
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    () => call(() => deliveryStatus(session.client(), () => session.summary())),
  );

  async function localWork(
    path: string,
    signal: AbortSignal,
    work: (changed: (path: string) => void) => Promise<object>,
    captured?: Client,
  ): Promise<object> {
    let admitted = false;
    try {
      if (session.mode !== "writable")
        throw new NoteError("read_only", "this process cannot change notes");
      const client = captured ?? session.client();
      if (!client?.writeReady)
        throw new NoteError(
          "not_ready",
          "wait for a settled live connection before changing notes",
        );
      return await client.mutateLocal(
        async ({ changed }) => {
          if (session.mode !== "writable" || session.stopping())
            throw new NoteError("stopping", "this process cannot admit a mutation");
          admitted = true;
          let invalidated = false;
          const result = await work((path) => {
            if (!invalidated) {
              session.changed();
              invalidated = true;
            }
            changed(path);
          });
          return { ...result, connection: session.summary() };
        },
        { signal },
      );
    } catch (error) {
      return {
        path,
        applied: admitted ? "unknown" : false,
        ...(admitted ? { durable: "unknown" } : {}),
        preserved: [],
        error: toolFailure(error),
        connection: session.summary(),
      };
    }
  }

  async function mutation(
    request: NoteMutation,
    signal: AbortSignal,
    captured?: Client,
  ): Promise<object> {
    return localWork(
      request.path,
      signal,
      (changed) => mutateNote(session.writer, request, changed),
      captured,
    );
  }
  async function operation(
    request: VaultOperation,
    changes: readonly PlannedChange[] | undefined,
    signal: AbortSignal,
  ): Promise<object> {
    if (changes === undefined)
      return session.reader.run(() => previewOperation(session.reader.vault, request), signal);
    return localWork(request.kind === "tags" ? "" : request.path, signal, (changed) =>
      session.reader.run(() =>
        applyOperation(session.writer, session.reader.vault, request, changes, changed),
      ),
    );
  }

  if (session.mode === "writable") {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    const previewDescription =
      " Without changes, returns a read-only preview. To apply, resubmit every exact change and required base. Preserves all originals first; partial results and ambiguous links require inspection.";
    server.registerTool(
      "add_tags",
      {
        description:
          "Add tags to selected notes, preserving unrelated frontmatter and prose." +
          previewDescription,
        inputSchema: addTagsSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { paths, changes, ...change } = input;
          return operation(
            { kind: "tags", paths, change: { operation: "add", ...change } },
            changes,
            ctx.mcpReq.signal,
          );
        }),
    );
    server.registerTool(
      "remove_tags",
      {
        description:
          "Remove exact, nested or wildcard-selected tags from selected notes." +
          previewDescription,
        inputSchema: removeTagsSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { paths, changes, ...change } = input;
          return operation(
            { kind: "tags", paths, change: { operation: "remove", ...change } },
            changes,
            ctx.mcpReq.signal,
          );
        }),
    );
    server.registerTool(
      "manage_tags",
      {
        description:
          "Add or remove tags using the same exact-span workflow as add_tags and remove_tags." +
          previewDescription,
        inputSchema: manageTagsSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { paths, changes, ...change } = input;
          return operation({ kind: "tags", paths, change }, changes, ctx.mcpReq.signal);
        }),
    );
    server.registerTool(
      "rename_tag",
      {
        description:
          "Rename a tag across the vault or a selected folder. Recovery copies are immutable and omitted." +
          previewDescription,
        inputSchema: renameTagSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { folder, changes, ...change } = input;
          return operation(
            { kind: "tags", folder, change: { operation: "rename", ...change } },
            changes,
            ctx.mcpReq.signal,
          );
        }),
    );
    server.registerTool(
      "move_note",
      {
        description:
          "Move a note to a free path, maintaining relative outbound links and optionally updating unambiguous backlinks. Verified copy, backlink edits, then recoverable source deletion. Destination history starts at the new path." +
          previewDescription,
        inputSchema: moveSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { changes, ...request } = input;
          return operation({ kind: "move", ...request }, changes, ctx.mcpReq.signal);
        }),
    );
    server.registerTool(
      "delete_note",
      {
        description:
          "Recoverably delete a note after a verified before-image. Backlinks stay unchanged unless markBroken requests visible strike-through markers. No permanent deletion." +
          previewDescription,
        inputSchema: deleteSchema,
        annotations,
      },
      (input, ctx) =>
        call(() => {
          const { changes, ...request } = input;
          return operation({ kind: "delete", ...request }, changes, ctx.mcpReq.signal);
        }),
    );
    server.registerTool(
      "create_directory",
      {
        description:
          "Create and flush a checked vault-relative directory. Existing directories are a no-op; occupied file paths are refused.",
        inputSchema: directorySchema,
        annotations: { ...annotations, destructiveHint: false },
      },
      (input, ctx) =>
        call(() =>
          localWork(input.path, ctx.mcpReq.signal, (changed) =>
            createDirectory(session.writer, input.path, changed),
          ),
        ),
    );
    server.registerTool(
      "edit_note",
      {
        description:
          "Apply 1 to 32 exact, unique old-to-new edits against a required base. Saves a verified before-image first. On stale or unknown outcome, reread and reconsider; never substitute a new base automatically.",
        inputSchema: editSchema,
        annotations,
      },
      (input, ctx) => call(() => mutation({ kind: "edit", ...input }, ctx.mcpReq.signal)),
    );
    server.registerTool(
      "append_note",
      {
        description:
          "Append exact text to an existing note with its required base, preserving a before-image. No separator is added. On uncertain outcome, inspect before retrying.",
        inputSchema: appendSchema,
        annotations: { ...annotations, destructiveHint: false },
      },
      (input, ctx) => call(() => mutation({ kind: "append", ...input }, ctx.mcpReq.signal)),
    );
    server.registerTool(
      "prepend_note",
      {
        description:
          "Prepend exact text after an existing UTF-8 BOM, using a required base and verified before-image. Supply separators. Inspect uncertain outcomes before retrying.",
        inputSchema: appendSchema,
        annotations: { ...annotations, destructiveHint: false },
      },
      (input, ctx) => call(() => mutation({ kind: "prepend", ...input }, ctx.mcpReq.signal)),
    );
    server.registerTool(
      "create_note",
      {
        description:
          "Create a new Markdown or text note only at an unoccupied path. Never replaces a note.",
        inputSchema: createSchema,
        annotations: { ...annotations, destructiveHint: false },
      },
      (input, ctx) => call(() => mutation({ kind: "create", ...input }, ctx.mcpReq.signal)),
    );
  }
  if (session.mode === "writable") {
    server.registerTool(
      "restore_note",
      {
        description:
          "Restore a previously inspected server version to a distinct, explicitly chosen free path. Never overwrites or invents a second destination on retry.",
        inputSchema: restoreSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      (input, ctx) =>
        call(async () => {
          try {
            if (session.mode !== "writable" || session.stopping())
              throw new NoteError("read_only", "this process cannot restore notes");
            const client = session.client();
            if (!client?.writeReady)
              throw new NoteError(
                "not_ready",
                "wait for a settled live connection before restoring",
              );
            noteFormat(input.to, true);
            const source = await history.path(input.path, ctx.mcpReq.signal);
            const destination = await session.reader.run(
              () => session.reader.vault.checkPath(input.to, { allowMissing: true }),
              ctx.mcpReq.signal,
            );
            if (
              session.reader.vault.canonical(source) ===
              session.reader.vault.canonical(destination.path)
            )
              throw new NoteError(
                "same_destination",
                "restore to a different path so the original stays available",
              );
            if (destination.exists)
              throw new NoteError("exists", "the restore destination is already occupied");
            const content = await history.content(source, input.uid, ctx.mcpReq.signal, client);
            const result = await mutation(
              { kind: "create", path: destination.path, content: noteText(content.bytes) },
              ctx.mcpReq.signal,
              client,
            );
            return { ...result, restoredFrom: { path: content.path, uid: content.version.uid } };
          } catch (error) {
            return { path: input.to, applied: false, preserved: [], error: toolFailure(error) };
          }
        }),
    );
  }

  return {
    async drain() {
      await Promise.all(pending);
    },
  };
}

export interface NamedMcpSession {
  readonly id: string;
  readonly session: McpSession;
}
interface ToolConfig<S extends z.ZodType> {
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
}
type RegisterTool = <S extends z.ZodType>(
  name: string,
  config: ToolConfig<S>,
  handler: (input: z.output<S>, context: ServerContext) => Promise<CallToolResult>,
) => void;

export function createTools(session: McpSession, version: string) {
  return createVaultTools([{ id: "default", session }], version);
}

export function createVaultTools(vaults: readonly NamedMcpSession[], version: string) {
  if (
    !vaults.length ||
    vaults.length > 10 ||
    new Set(vaults.map((vault) => vault.id)).size !== vaults.length ||
    vaults.some((vault) => !/^[a-z][a-z0-9_-]{0,31}$/u.test(vault.id))
  )
    throw new NoteError("invalid_vaults", "configure between one and ten distinct vault names");
  const server = new TrackedMcpServer({ name: "trew", version });
  const definitions = new Map<
    string,
    {
      config: ToolConfig<z.ZodType>;
      handlers: Map<string, (input: unknown, context: ServerContext) => Promise<CallToolResult>>;
    }
  >();
  const registries = vaults.map(({ id, session }) =>
    sessionTools(session, (name, config, handler) => {
      let definition = definitions.get(name);
      if (!definition) {
        definition = { config, handlers: new Map() };
        definitions.set(name, definition);
      }
      definition.handlers.set(id, (input, context) =>
        handler(config.inputSchema.parse(input), context),
      );
    }),
  );
  const aliases = z.enum(vaults.map((vault) => vault.id) as [string, ...string[]]);
  const selector = vaults.length === 1 ? aliases.optional() : aliases;
  const selectedSchema = (schema: z.core.$ZodType): z.ZodType => {
    if (schema instanceof z.ZodObject) return schema.safeExtend({ vault: selector });
    if (schema instanceof z.ZodDiscriminatedUnion)
      return z.union(schema.options.map((option) => selectedSchema(option)));
    throw new Error("tool inputs must be strict objects or discriminated objects");
  };
  for (const [name, definition] of definitions) {
    server.registerTool(
      name,
      { ...definition.config, inputSchema: selectedSchema(definition.config.inputSchema) },
      async (input, context) => {
        const { vault, ...args } = input as Record<string, unknown>;
        const handler = definition.handlers.get((vault as string | undefined) ?? vaults[0]!.id);
        if (!handler)
          return toolResult(
            {
              applied: false,
              error: {
                code: "read_only",
                message: "the selected vault does not permit this mutation",
              },
            },
            true,
          );
        return handler(args, context);
      },
    );
  }
  server.registerTool(
    "list_vaults",
    {
      description:
        "List explicitly configured vault names, access modes and connection readiness. Host paths and credentials are never returned. With multiple vaults, every other tool requires its vault name.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      toolResult({
        vaults: vaults.map(({ id, session }) => ({ id, mode: session.mode, ...session.summary() })),
      }),
  );
  return {
    server,
    async drain() {
      await Promise.all(registries.map((registry) => registry.drain()));
    },
  };
}
