// be/src/work-hours-calculator.ts

// 論理的な日付を取得するヘルパー関数
export function getLogicalDate(timestamp: Date, resetHour: number): Date {
  const date = new Date(timestamp);
  // もし現在の時刻がリセット時刻より前なら、日付を1日戻す
  if (date.getHours() < resetHour) {
    date.setDate(date.getDate() - 1);
  }
  date.setHours(0, 0, 0, 0); // 時刻は0時に揃える
  return date;
}

// Helper to format duration
export function calculateLogsDuration(logs: { type: string; timestamp: Date }[], resetHour: number): { [date: string]: number } {
    const dailyTotals: { [date: string]: number } = {};

    let lastStartTime: number | null = null;

    // ログは古い順 (asc) であることを前提とする
    for (const log of logs) {
        const time = log.timestamp.getTime();
        const dateObj = log.timestamp;
        
        // Calculate logical date string (YYYY-MM-DD)
        const logicalDate = getLogicalDate(dateObj, resetHour);
        const dateKey = logicalDate.toISOString().split('T')[0];

        if (!dailyTotals[dateKey]) dailyTotals[dateKey] = 0;

        if (log.type === 'work_start' || log.type === 'break_end') {
            if (lastStartTime === null) {
                lastStartTime = time;
            }
        } else if (log.type === 'work_end' || log.type === 'break_start') {
            if (lastStartTime !== null) {
                // 開始時刻が属する日の合計に加算する
                const startLogDate = new Date(lastStartTime);
                const startLogicalDate = getLogicalDate(startLogDate, resetHour);
                const startDateKey = startLogicalDate.toISOString().split('T')[0];
                
                if (!dailyTotals[startDateKey]) dailyTotals[startDateKey] = 0;
                
                dailyTotals[startDateKey] += (time - lastStartTime);
                lastStartTime = null;
            }
        }
    }
    
    return dailyTotals;
}
