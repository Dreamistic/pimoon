export const scenarios: Record<"independent-review" | "process-check" | "locate-edit" | "conditional-edit", {
  prompt: string;
  setup(cwd: string): Promise<void>;
  verify(cwd: string): Promise<void>;
}>;
