import { describe, expect, it } from "vitest";
import { contextFiles } from "../src/lib/chat/contextLoader";
describe("chat context selection", () => { it("keeps standard context concise", () => expect(contextFiles("standard")).toEqual(["PROJECT_CONTEXT_SUMMARY.md"])); it("loads all technical documents in detailed mode", () => expect(contextFiles("detailed")).toHaveLength(4)); });
