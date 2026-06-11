import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inferType } from "../../src/tools/control.js";
import { createTestServer, callTool, parseToolResult, cleanupDeps } from "./_helpers.js";

describe("inferType", () => {
  it("returns 'bool' for booleans", () => {
    expect(inferType(true)).toBe("bool");
    expect(inferType(false)).toBe("bool");
  });

  it("returns 'int' for integers", () => {
    expect(inferType(0)).toBe("int");
    expect(inferType(42)).toBe("int");
    expect(inferType(-1)).toBe("int");
  });

  it("returns 'double' for floats", () => {
    expect(inferType(3.14)).toBe("double");
    expect(inferType(0.5)).toBe("double");
  });

  it("returns 'string' for strings", () => {
    expect(inferType("hello")).toBe("string");
    expect(inferType("")).toBe("string");
  });
});

describe("set_value handler", () => {
  it("reads previous value before writing", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn()
        .mockResolvedValueOnce(21.5)    // getValue (pre-read)
        .mockResolvedValueOnce(true),   // setValue
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "SET_POINT_TEMPERATURE", value: 22.0, interface: "HmIP-RF", type: "double",
    }));

    expect((result as any).previousValue).toBe(21.5);
    expect((result as any).newValue).toBe(22.0);
    cleanupDeps(deps);
  });

  it("continues write if previous-value read fails", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn()
        .mockRejectedValueOnce(new Error("unreachable"))  // getValue fails
        .mockResolvedValueOnce(true),                       // setValue succeeds
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "STATE", value: true, interface: "HmIP-RF", type: "bool",
    }));

    expect((result as any).previousValue).toBe(null);
    expect((result as any).newValue).toBe(true);
    cleanupDeps(deps);
  });

  it("falls back to inferType when type not provided and cache empty", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValue(true),
    });

    const result = parseToolResult(await callTool(server, "set_value", {
      address: "ABC123:1", valueKey: "STATE", value: true, interface: "HmIP-RF",
    }));

    expect((result as any).type).toBe("bool");
    cleanupDeps(deps);
  });
});

describe("set_system_variable handler", () => {
  // Regression: missing variables silently fell back to SysVar.setBool (issue #9)
  it("returns NOT_FOUND error when the variable does not exist", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValueOnce([{ name: "Anwesenheit", type: "BOOL" }]), // SysVar.getAll
    });

    const result: any = await callTool(server, "set_system_variable", { name: "DoesNotExist", value: true });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("NOT_FOUND");
    expect(parsed.message).toContain("DoesNotExist");
    cleanupDeps(deps);
  });

  it("returns INVALID_INPUT error for unsupported variable types", async () => {
    const { server, deps } = createTestServer({
      sessionCall: vi.fn().mockResolvedValueOnce([{ name: "Weird", type: "TIMESTAMP" }]), // SysVar.getAll
    });

    const result: any = await callTool(server, "set_system_variable", { name: "Weird", value: "x" });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("INVALID_INPUT");
    cleanupDeps(deps);
  });

  // Issue #10: variable types are cached for 30s — one SysVar.getAll across calls
  it("caches sysvar types so repeated writes fetch SysVar.getAll only once", async () => {
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") return [{ name: "Anwesenheit", type: "BOOL" }];
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });
    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: false });

    const getAllCalls = sessionCall.mock.calls.filter((c: unknown[]) => c[0] === "SysVar.getAll");
    expect(getAllCalls.length).toBe(1);
    cleanupDeps(deps);
  });

  it("refetches the sysvar list on a fresh-cache miss (new variable)", async () => {
    let round = 0;
    const sessionCall = vi.fn().mockImplementation(async (method: string) => {
      if (method === "SysVar.getAll") {
        round++;
        return round === 1
          ? [{ name: "Anwesenheit", type: "BOOL" }]
          : [{ name: "Anwesenheit", type: "BOOL" }, { name: "NeueVariable", type: "FLOAT" }];
      }
      return true;
    });
    const { server, deps } = createTestServer({ sessionCall });

    await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true });
    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "NeueVariable", value: 1.5 }));

    expect((result as any).method).toBe("SysVar.setFloat");
    expect(round).toBe(2); // cache was fresh but missed → refetched
    cleanupDeps(deps);
  });

  it("uses SysVar.setBool for bool variables", async () => {
    const sessionCall = vi.fn()
      .mockResolvedValueOnce([{ name: "Anwesenheit", type: "BOOL" }]) // SysVar.getAll
      .mockResolvedValueOnce(true);                                    // SysVar.setBool
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "set_system_variable", { name: "Anwesenheit", value: true }));

    expect((result as any).method).toBe("SysVar.setBool");
    expect(sessionCall).toHaveBeenLastCalledWith("SysVar.setBool", { name: "Anwesenheit", value: true });
    cleanupDeps(deps);
  });
});

describe("execute_program handler", () => {
  it("calls Program.execute and returns success", async () => {
    const sessionCall = vi.fn().mockResolvedValue(true);
    const { server, deps } = createTestServer({ sessionCall });

    const result = parseToolResult(await callTool(server, "execute_program", { id: "123" }));

    expect((result as any).executed).toBe(true);
    expect(sessionCall).toHaveBeenCalledWith("Program.execute", expect.objectContaining({ id: "123" }));
    cleanupDeps(deps);
  });
});
