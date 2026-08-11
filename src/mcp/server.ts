import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { sanitizeAlias } from "../auth/google-handler.js";
import {
  errorResult,
  getUpstreamAuthorizeUrl,
  jsonResult,
  textResult,
  WORKSPACE_SCOPES,
  type Props,
} from "../auth/utils.js";
import * as calendarApi from "../google/calendar.js";
import * as driveApi from "../google/drive.js";
import { withAccounts, withSingleAccount } from "../google/fanout.js";
import * as gmailApi from "../google/gmail.js";
import { deleteAccount, listAccounts } from "../storage/kv.js";

const ADD_ACCOUNT_STATE_TTL = 600;

const accountSchema = z
  .string()
  .min(1)
  .describe('Account alias (e.g. "personal", "work"), email, or "all" for fan-out');

const accountRequiredSchema = z
  .string()
  .min(1)
  .describe('Account alias (e.g. "personal", "work"). Cannot be "all".');

export class WorkspaceMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "multigmail",
    version: "0.1.0",
  });

  private get userProps(): Props {
    return this.props!;
  }

  private get bindings(): Env {
    return this.env!;
  }

  private workerOrigin(): string {
    const configured = (this.bindings.WORKER_URL || "").replace(/\/$/, "");
    if (!configured) {
      throw new Error(
        "WORKER_URL is not set. Set it to your public Worker origin (e.g. https://multigmail.example.workers.dev) so add_account can build the Google OAuth URL.",
      );
    }
    return configured;
  }

  async init() {
    this.registerAccountTools();
    this.registerGmailTools();
    this.registerCalendarTools();
    this.registerDriveTools();
  }

  private registerAccountTools() {
    this.server.tool(
      "list_accounts",
      "List linked Google account aliases and emails for this Claude connection",
      {},
      async () => {
        try {
          const accounts = await listAccounts(
            this.bindings.TOKEN_STORE,
            this.bindings.COOKIE_ENCRYPTION_KEY,
            this.userProps.userId,
          );
          if (accounts.length === 0) {
            return textResult(
              'No accounts linked yet. Call add_account with an alias like "personal" or "work".',
            );
          }
          return jsonResult(
            accounts.map((a) => ({
              alias: a.alias,
              email: a.email,
              scopes: a.scopes,
              apis: ["gmail", "calendar", "drive"],
            })),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "add_account",
      "Start Google OAuth to link another account under an alias. Returns a URL to open in a browser.",
      {
        alias: z
          .string()
          .min(1)
          .describe('Short alias for this account, e.g. "personal" or "work" (not "all")'),
      },
      async ({ alias }) => {
        try {
          const clean = sanitizeAlias(alias);
          const stateToken = crypto.randomUUID();
          await this.bindings.OAUTH_KV.put(
            `add-account:state:${stateToken}`,
            JSON.stringify({ userId: this.userProps.userId, alias: clean }),
            { expirationTtl: ADD_ACCOUNT_STATE_TTL },
          );

          const origin = this.workerOrigin();
          const url = getUpstreamAuthorizeUrl({
            clientId: this.bindings.GOOGLE_CLIENT_ID,
            redirectUri: `${origin}/callback`,
            scope: WORKSPACE_SCOPES,
            state: stateToken,
            upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          });

          return textResult(
            `Open this URL to link Google account as "${clean}" (expires in 10 minutes):\n\n${url}\n\nAfter approving, call list_accounts to confirm.`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "remove_account",
      "Remove a linked Google account alias from this connector (does not revoke Google access by itself)",
      {
        alias: z.string().min(1).describe("Alias to remove"),
      },
      async ({ alias }) => {
        try {
          const clean = sanitizeAlias(alias);
          const removed = await deleteAccount(
            this.bindings.TOKEN_STORE,
            this.userProps.userId,
            clean,
          );
          return textResult(
            removed
              ? `Removed account alias "${clean}". Optionally revoke app access at myaccount.google.com/permissions.`
              : `No account found for alias "${clean}".`,
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  private registerGmailTools() {
    this.server.tool(
      "search_emails",
      "Search Gmail with Gmail query syntax. Use account \"all\" to search every linked inbox.",
      {
        account: accountSchema,
        query: z.string().describe("Gmail search query, e.g. from:boss@ is:unread"),
        max_results: z.number().min(1).max(50).optional().default(10),
      },
      async ({ account, query, max_results }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.searchEmails(token, query, max_results),
          );
          return jsonResult(results);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "get_email",
      "Read a full Gmail message by ID from a specific account",
      {
        account: accountRequiredSchema,
        message_id: z.string(),
      },
      async ({ account, message_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.getEmail(token, message_id),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "get_thread",
      "Read a full Gmail thread by ID from a specific account",
      {
        account: accountRequiredSchema,
        thread_id: z.string(),
      },
      async ({ account, thread_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.getThread(token, thread_id),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "list_labels",
      "List Gmail labels for an account (or all accounts)",
      { account: accountSchema },
      async ({ account }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.listLabels(token),
          );
          return jsonResult(results);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "modify_labels",
      "Add/remove Gmail labels on a message",
      {
        account: accountRequiredSchema,
        message_id: z.string(),
        add_label_ids: z.array(z.string()).optional().default([]),
        remove_label_ids: z.array(z.string()).optional().default([]),
      },
      async ({ account, message_id, add_label_ids, remove_label_ids }) => {
        try {
          await withSingleAccount(this.bindings, this.userProps.userId, account, (token) =>
            gmailApi.modifyLabels(token, message_id, add_label_ids, remove_label_ids),
          );
          return textResult(`Updated labels on ${message_id}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "create_draft",
      "Create a Gmail draft on a specific account",
      {
        account: accountRequiredSchema,
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
      },
      async ({ account, to, subject, body, cc }) => {
        try {
          const draftId = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.createDraft(token, gmailApi.buildMimeMessage({ to, subject, body, cc })),
          );
          return textResult(`Draft created: ${draftId}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "send_email",
      "Send an email from a specific account",
      {
        account: accountRequiredSchema,
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        cc: z.string().optional(),
      },
      async ({ account, to, subject, body, cc }) => {
        try {
          const messageId = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => gmailApi.sendEmail(token, gmailApi.buildMimeMessage({ to, subject, body, cc })),
          );
          return textResult(`Email sent: ${messageId}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "archive_email",
      "Archive a Gmail message (remove INBOX label)",
      {
        account: accountRequiredSchema,
        message_id: z.string(),
      },
      async ({ account, message_id }) => {
        try {
          await withSingleAccount(this.bindings, this.userProps.userId, account, (token) =>
            gmailApi.modifyLabels(token, message_id, [], ["INBOX"]),
          );
          return textResult(`Archived ${message_id}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "trash_email",
      "Move a Gmail message to trash",
      {
        account: accountRequiredSchema,
        message_id: z.string(),
      },
      async ({ account, message_id }) => {
        try {
          await withSingleAccount(this.bindings, this.userProps.userId, account, (token) =>
            gmailApi.trashEmail(token, message_id),
          );
          return textResult(`Trashed ${message_id}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  private registerCalendarTools() {
    this.server.tool(
      "list_calendars",
      "List calendars for one account or all linked accounts",
      { account: accountSchema },
      async ({ account }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => calendarApi.listCalendars(token),
          );
          return jsonResult(results);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "list_events",
      "List calendar events in a time range. Use account \"all\" to merge events across every linked account.",
      {
        account: accountSchema,
        time_min: z.string().describe("RFC3339 start, e.g. 2026-08-10T00:00:00Z"),
        time_max: z.string().describe("RFC3339 end"),
        calendar_id: z.string().optional().default("primary"),
        max_results: z.number().min(1).max(100).optional().default(25),
        query: z.string().optional(),
      },
      async ({ account, time_min, time_max, calendar_id, max_results, query }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            async (token, acct) => {
              const events = await calendarApi.listEvents(token, {
                calendarId: calendar_id,
                timeMin: time_min,
                timeMax: time_max,
                maxResults: max_results,
                query,
              });
              return events.map((e) => ({ ...e, account: acct.alias, email: acct.email }));
            },
          );

          const merged = results
            .flatMap((r) =>
              (r.data ?? []).map((e) => ({
                ...e,
                ok: r.ok,
                error: r.error,
              })),
            )
            .sort((a, b) => String(a.start).localeCompare(String(b.start)));

          return jsonResult({
            accounts: results.map(({ account: a, email, ok, error }) => ({
              account: a,
              email,
              ok,
              error,
            })),
            events: merged,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "get_event",
      "Get a calendar event by ID from a specific account",
      {
        account: accountRequiredSchema,
        event_id: z.string(),
        calendar_id: z.string().optional().default("primary"),
      },
      async ({ account, event_id, calendar_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => calendarApi.getEvent(token, calendar_id, event_id),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "create_event",
      "Create a calendar event on a specific account",
      {
        account: accountRequiredSchema,
        summary: z.string(),
        start: z.string().describe("RFC3339 date-time or YYYY-MM-DD for all-day"),
        end: z.string().describe("RFC3339 date-time or YYYY-MM-DD for all-day"),
        calendar_id: z.string().optional().default("primary"),
        description: z.string().optional(),
        location: z.string().optional(),
        time_zone: z.string().optional(),
        attendees: z.array(z.string().email()).optional(),
      },
      async (args) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            args.account,
            (token) =>
              calendarApi.createEvent(token, {
                calendarId: args.calendar_id,
                summary: args.summary,
                description: args.description,
                location: args.location,
                start: args.start,
                end: args.end,
                timeZone: args.time_zone,
                attendees: args.attendees,
              }),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "update_event",
      "Update a calendar event on a specific account",
      {
        account: accountRequiredSchema,
        event_id: z.string(),
        calendar_id: z.string().optional().default("primary"),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        time_zone: z.string().optional(),
      },
      async (args) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            args.account,
            (token) =>
              calendarApi.updateEvent(token, {
                calendarId: args.calendar_id,
                eventId: args.event_id,
                summary: args.summary,
                description: args.description,
                location: args.location,
                start: args.start,
                end: args.end,
                timeZone: args.time_zone,
              }),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "delete_event",
      "Delete a calendar event on a specific account",
      {
        account: accountRequiredSchema,
        event_id: z.string(),
        calendar_id: z.string().optional().default("primary"),
      },
      async ({ account, event_id, calendar_id }) => {
        try {
          await withSingleAccount(this.bindings, this.userProps.userId, account, (token) =>
            calendarApi.deleteEvent(token, calendar_id, event_id),
          );
          return textResult(`Deleted event ${event_id}`);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "freebusy",
      "Check busy windows across calendars. Use account \"all\" to schedule across every linked Google account.",
      {
        account: accountSchema,
        time_min: z.string(),
        time_max: z.string(),
        calendar_ids: z
          .array(z.string())
          .optional()
          .describe("Calendar IDs to check; defaults to primary for each account"),
      },
      async ({ account, time_min, time_max, calendar_ids }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            (token) =>
              calendarApi.freebusy(token, {
                timeMin: time_min,
                timeMax: time_max,
                calendarIds: calendar_ids,
              }),
          );
          return jsonResult(results);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "respond_event",
      "Accept, decline, or tentatively accept a calendar invitation on a specific account",
      {
        account: accountRequiredSchema,
        event_id: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
        calendar_id: z.string().optional().default("primary"),
      },
      async ({ account, event_id, response, calendar_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token, acct) =>
              calendarApi.respondEvent(token, {
                calendarId: calendar_id,
                eventId: event_id,
                response,
                email: acct.email,
              }),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  private registerDriveTools() {
    this.server.tool(
      "drive_search",
      "Search Google Drive files. Use account \"all\" to search every linked Drive.",
      {
        account: accountSchema,
        query: z.string().optional().describe("Free-text search"),
        q: z.string().optional().describe("Raw Drive API q parameter"),
        max_results: z.number().min(1).max(50).optional().default(20),
      },
      async ({ account, query, q, max_results }) => {
        try {
          const results = await withAccounts(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => driveApi.searchFiles(token, { query, q, maxResults: max_results }),
          );
          return jsonResult(results);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "drive_get_file",
      "Get Drive file metadata; optionally export text content for Docs/Sheets/text files",
      {
        account: accountRequiredSchema,
        file_id: z.string(),
        include_content: z.boolean().optional().default(false),
      },
      async ({ account, file_id, include_content }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => driveApi.getFile(token, file_id, include_content),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "drive_list_folder",
      "List files in a Drive folder (use folder_id \"root\" for My Drive)",
      {
        account: accountRequiredSchema,
        folder_id: z.string().optional().default("root"),
        max_results: z.number().min(1).max(100).optional().default(50),
      },
      async ({ account, folder_id, max_results }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => driveApi.listFolder(token, folder_id, max_results),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "drive_create_folder",
      "Create a folder in Drive on a specific account",
      {
        account: accountRequiredSchema,
        name: z.string(),
        parent_id: z.string().optional(),
      },
      async ({ account, name, parent_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => driveApi.createFolder(token, name, parent_id),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    this.server.tool(
      "drive_trash",
      "Move a Drive file or folder to trash on a specific account",
      {
        account: accountRequiredSchema,
        file_id: z.string(),
      },
      async ({ account, file_id }) => {
        try {
          const data = await withSingleAccount(
            this.bindings,
            this.userProps.userId,
            account,
            (token) => driveApi.trashFile(token, file_id),
          );
          return jsonResult(data);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
}
