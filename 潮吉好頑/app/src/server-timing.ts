// Server-Timing：記下 Worker 內各外部請求（LINE、Supabase）的耗時，開機計時報告（?cj_timing=1）顯示在對應請求後面，
// 用來分辨慢在哪一步。只有步驟名稱與毫秒數，不含任何資料。
// Workers 的時鐘只在 I/O 時前進，量得到的就是等外部回應的時間。
export class ServerTiming {
  private readonly started = Date.now();
  private readonly entries: Array<[string, number]> = [];

  /** 等待 task 並記下耗時；task 失敗時照樣記錄後再拋出。 */
  async measure<T>(name: string, task: Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await task;
    } finally {
      this.entries.push([name, Date.now() - start]);
    }
  }

  /** Server-Timing 標頭值，最後附上 Worker 收到請求到現在的總時間（total）。 */
  header() {
    return [...this.entries, ["total", Date.now() - this.started] as [string, number]]
      .map(([name, duration]) => `${name};dur=${duration}`)
      .join(", ");
  }
}
