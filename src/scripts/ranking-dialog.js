import { registerBlock } from './block-dialog.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rankingBlock(title, rows, format) {
  const snapshot = rows.map(row => ({ ...row }));
  return {
    title,
    initial: { order: 'amount', limit: 'all', bars: true },
    controls: [
      { key: 'order', label: 'Sort by', choices: [{ value: 'amount', label: 'Largest amount' }, { value: 'name', label: 'Name' }] },
      { key: 'limit', label: 'Rows shown', choices: [{ value: 'all', label: 'All rows' }, { value: '6', label: 'Top 6' }, { value: '10', label: 'Top 10' }] },
      { key: 'bars', label: 'Show amount bars', type: 'checkbox' },
    ],
    render(container, settings) {
      const sorted = [...snapshot].sort(settings.order === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.amount - a.amount);
      const visible = settings.limit === 'all' ? sorted : sorted.slice(0, Number(settings.limit));
      const max = Math.max(1, ...snapshot.map(row => row.amount));
      container.innerHTML = visible.length ? `<div class="expanded-ranking">${visible.map(row => `<div class="expanded-ranking-row"><div><span>${esc(row.name)}</span><strong>${esc(format(row.amount))}</strong></div>${settings.bars ? `<div class="bar-track"><div class="bar-fill" style="width:${row.amount / max * 100}%;background:var(--chart-1)"></div></div>` : ''}</div>`).join('')}</div>` : '<p class="no-results">No spending in this period.</p>';
    },
  };
}

export function registerRanking(container, title, amounts, format) {
  registerBlock(container, rankingBlock(title, Object.entries(amounts).map(([name, amount]) => ({ name, amount })), format));
}
