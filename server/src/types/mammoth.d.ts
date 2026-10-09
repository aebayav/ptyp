// mammoth için yerel tip bildirimi (@types/mammoth npm'de yok)
declare module 'mammoth' {
  interface ExtractResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer }): Promise<ExtractResult>;
}
