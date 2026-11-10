import { Type, type Static } from "typebox";
import { compileSchemaValidator } from "../../../harness/schema-validator.ts";
import type { GuiDialog } from "../../shared/protocol/state.ts";

const object = <T extends import("typebox").TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1, maxLength: 64000 });
const items = Type.Array(text, { maxItems: 200 });
export const briefSchema = object({ goal: text, acceptance: items, constraints: items });
export const submitSchema = object({ cwd: Type.String({ minLength: 1, maxLength: 4096 }), ...briefSchema.properties, title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) });
export const messageSchema = object({ text });
export const reviewSchema = object({ verdict: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]), feedback: Type.Optional(text) });
export const dialogSchema = object({ value: Type.Union([Type.String({ maxLength: 64000 }), Type.Null()]), feedback: Type.Optional(Type.String({ maxLength: 2000 })),
	answers: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }), Type.Union([Type.Boolean(), Type.String({ maxLength: 160 })]), { maxProperties: 32 })) });
export const deliverySchema = object({ summary: text, changes: items, verification: items, unverified: items, objections: items });
const nullableText = Type.Union([Type.String({ maxLength: 64000 }), Type.Null()]);
const deliveryRecord = object({ ...deliverySchema.properties, head: nullableText, at: text });
const verdictRecord = object({ ...reviewSchema.properties, at: text });
const taskSchema = object({
	id: text, sessionFile: text, cwd: text, repository: text, createdAt: text, brief: briefSchema,
	base: object({ head: nullableText, dirty: Type.Boolean() }),
	delivery: Type.Union([deliveryRecord, Type.Null()]), verdict: Type.Union([verdictRecord, Type.Null()]),
	cancelled: Type.Boolean(), lastError: nullableText,
	history: Type.Array(object({ delivery: deliveryRecord, feedback: text, at: text })),
});
export const tasksSchema = Type.Array(taskSchema, { maxItems: 10000 });
export type BridgeTask = Static<typeof taskSchema>;
export type BridgeSubmit = Static<typeof submitSchema>;
export type BridgeDelivery = Static<typeof deliverySchema>;
export type BridgeReview = Static<typeof reviewSchema>;
export type BridgeDialogReply = Static<typeof dialogSchema>;
export type BridgeState = "lost" | "accepted" | "cancelled" | "running" | "waiting" | "delivered" | "stalled";
export type BridgeTaskView = BridgeTask & { state: BridgeState; dialogs: GuiDialog[]; lastAssistant?: string };
export class BridgeError extends Error {
	constructor(readonly status: number, message: string, readonly taskId?: string) { super(message); this.name = "BridgeError"; }
}
export function parseBridge<T>(schema: object): (value: unknown) => T {
	const validate = compileSchemaValidator(schema);
	return value => { if (!validate(value)) throw new BridgeError(400, "无效桥接参数。"); return value as T; };
}
export const parseSubmit = parseBridge<BridgeSubmit>(submitSchema);
export const parseMessage = parseBridge<Static<typeof messageSchema>>(messageSchema);
export const parseReview = parseBridge<BridgeReview>(reviewSchema);
export const parseDialog = parseBridge<BridgeDialogReply>(dialogSchema);
export const parseDelivery = parseBridge<BridgeDelivery>(deliverySchema);
