// Select forecast movements at the available-cash boundary. This does not
// change classifications or source rows; account and asset views keep them all.
export function cashForecastTransactions(transactions, accounts = []) {
  const byId = new Map(accounts.map(account => [account.id, account]));
  return transactions.filter(transaction => {
    if (transaction.kind === 'transfer' || !transaction.amount) return true;
    const side = transaction.amount < 0 ? 'from' : 'to';
    const endpoint = transaction[`${side}Endpoint`];

    // An effective endpoint takes priority over legacy source-account fields.
    // A known external endpoint cannot be available cash owned by the user.
    if (endpoint?.owned === false) return false;
    const linkedId = endpoint?.accountId || (endpoint?.owned ? endpoint.id : null)
      || transaction[`${side}OwnedAccountId`] || transaction[`${side}AccountId`]
      || transaction.accountId;
    const account = byId.get(linkedId);
    const role = endpoint?.role ?? account?.role;
    const accountType = endpoint?.accountType ?? account?.accountType;
    if (accountType === 'investment') return false;
    if (['available', 'reserve', 'excluded'].includes(role)) return role === 'available';

    // Older imports may not identify the signed-side account. Keep their
    // existing behavior until ownership and its cash role can be established.
    return true;
  });
}
