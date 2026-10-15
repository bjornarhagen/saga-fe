// Snapshot values are observations, never inferred balances or transactions.
export const accountTypes = { checking: 'Everyday bank account', savings: 'Savings account', investment: 'Investment account', credit: 'Credit account', other: 'Other account' };
export const accountRoles = { available: 'Available cash', reserve: 'Savings reserve', excluded: 'Outside cash forecast' };

export function valueHistory(snapshots, movements, accountId) {
  const ordered = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  return ordered.map((snapshot, index) => {
    const previous = ordered[index - 1];
    if (!previous || previous.amount === null || snapshot.amount === null) return { ...snapshot, change: null, recordedMovement: null, unexplainedChange: null };
    let movement = 0n;
    for (const flow of movements) {
      if (flow.date <= previous.date || flow.date > snapshot.date) continue;
      if (flow.to?.accountId === accountId) movement += BigInt(flow.amount);
      if (flow.from?.accountId === accountId) movement -= BigInt(flow.amount);
    }
    const change = BigInt(snapshot.amount) - BigInt(previous.amount);
    const exact = value => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
      return Number(value);
    };
    return { ...snapshot, change: exact(change), recordedMovement: exact(movement), unexplainedChange: exact(change - movement) };
  });
}
