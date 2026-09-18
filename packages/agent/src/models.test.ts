import { describe, expect, test } from "bun:test";
import {
  builtInModels,
  clearConversationModel,
  emptyModelSettings,
  resolveModel,
  setConversationModel,
  setOrganizationModel,
  setProjectModel,
} from "./models";

describe("resolveModel", () => {
  test("falls back to the built-in choice and says so", () => {
    const got = resolveModel(emptyModelSettings(), { role: "worker" });
    expect(got.harness).toBe(builtInModels.worker.harness);
    expect(got.from).toBe("built-in");
  });

  test("the organisation default applies to every project", () => {
    const settings = setOrganizationModel(
      emptyModelSettings(),
      "ticket-agent",
      {
        harness: "claude-code",
        model: "opus",
      },
    );
    for (const projectId of ["p1", "p2"]) {
      const got = resolveModel(settings, { role: "ticket-agent", projectId });
      expect(got.model).toBe("opus");
      expect(got.from).toBe("organization");
    }
  });

  test("a project overrides the organisation for that role only", () => {
    let settings = setOrganizationModel(emptyModelSettings(), "ticket-agent", {
      harness: "claude-code",
      model: "opus",
    });
    settings = setProjectModel(settings, "p1", "ticket-agent", {
      harness: "codex",
      model: "gpt",
    });

    expect(
      resolveModel(settings, { role: "ticket-agent", projectId: "p1" }),
    ).toMatchObject({
      harness: "codex",
      from: "project",
    });
    // A different project is untouched.
    expect(
      resolveModel(settings, { role: "ticket-agent", projectId: "p2" }),
    ).toMatchObject({
      model: "opus",
      from: "organization",
    });
    // So is a different role in the same project.
    expect(
      resolveModel(settings, { role: "worker", projectId: "p1" }).from,
    ).toBe("built-in");
  });

  test("one conversation can be changed without disturbing the defaults", () => {
    let settings = setOrganizationModel(emptyModelSettings(), "task-agent", {
      harness: "claude-code",
      model: "opus",
    });
    settings = setConversationModel(settings, "conv-1", {
      harness: "codex",
      model: "gpt",
    });

    expect(
      resolveModel(settings, { role: "task-agent", conversationId: "conv-1" }),
    ).toMatchObject({
      harness: "codex",
      from: "conversation",
    });
    // Every other conversation still inherits.
    expect(
      resolveModel(settings, { role: "task-agent", conversationId: "conv-2" })
        .from,
    ).toBe("organization");
  });

  test("a conversation override beats a project override", () => {
    let settings = setProjectModel(emptyModelSettings(), "p1", "worker", {
      harness: "codex",
    });
    settings = setConversationModel(settings, "conv-1", {
      harness: "claude-code",
    });
    expect(
      resolveModel(settings, {
        role: "worker",
        projectId: "p1",
        conversationId: "conv-1",
      }).from,
    ).toBe("conversation");
  });

  test("clearing an override puts the conversation back on what it inherits", () => {
    let settings = setOrganizationModel(emptyModelSettings(), "worker", {
      harness: "codex",
    });
    settings = setConversationModel(settings, "conv-1", {
      harness: "claude-code",
    });
    settings = clearConversationModel(settings, "conv-1");

    const got = resolveModel(settings, {
      role: "worker",
      conversationId: "conv-1",
    });
    expect(got.harness).toBe("codex");
    expect(got.from).toBe("organization");
  });
});
