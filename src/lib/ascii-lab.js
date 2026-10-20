// Invented, fixed data for visual comparison. Never read the private ledger here.
export const LAB_METHODS = [
  { id: 'original', number: '01', name: 'Current', tag: 'SVG / CONTROL', description: 'The existing chart renderer and components. Our reference for every experiment.' },
  { id: 'backdrop', number: '02', name: 'ASCII backdrop', tag: 'PIXELS → CHARACTERS', description: 'The sampler from bjornarhagen.no, adapted to the chart itself. A click-through ASCII layer over the original geometry.' },
  { id: 'glyphs', number: '03', name: 'Plotted characters', tag: 'GEOMETRY → CHARACTERS', description: 'Lines and bars drawn directly with text characters. Terminal rules and character bars carry the feeling into the other components.' },
];

const money = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const labMoney = value => `${money.format(value / 100)} kr`;
export const labMonth = point => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'][Number(point.date.slice(5, 7)) - 1];

export const labHistory = [
  [4200000, 2920000, 400000], [4200000, 3180000, 400000],
  [4450000, 6260000, 400000], [4200000, 2740000, 400000],
  [4200000, 3030000, 400000], [4450000, 2840000, 400000],
].map(([income, spending, saving], i) => ({ date: `2026-0${i + 1}-01`, month: `2026-0${i + 1}`, income, spending, saving, out: spending + saving }));
let change = 0;
export const labCash = labHistory.map(point => ({ ...point, change: change += point.income - point.out }));
const sum = key => labHistory.reduce((total, point) => total + point[key], 0);
export const labTotals = { income: sum('income'), spending: sum('spending'), saving: sum('saving'), change: labCash.at(-1).change };

export const labCategories = [
  { name: 'Home & bills', amount: 9200000, color: 'var(--chart-1)' },
  { name: 'Food & groceries', amount: 4100000, color: 'var(--chart-2)' },
  { name: 'Travel & transport', amount: 2900000, color: 'var(--chart-3)' },
  { name: 'Everything else', amount: labTotals.spending - 16200000, color: 'var(--chart-4)' },
];
export const labPayments = [
  { name: 'Northside housing', note: '6 payments · Home & bills', amount: 7800000 },
  { name: 'Corner market', note: '48 payments · Food & groceries', amount: 2800000 },
  { name: 'City transit', note: '12 payments · Travel & transport', amount: 720000 },
];

const common = { format: labMoney, label: labMonth, width: 560, height: 250, scale: 'linear' };
export const labCharts = [
  { id: 'cashflow', eyebrow: '01 / GROUPED BARS', title: 'Money in, money out', note: 'Spending and savings contributions form money out. Internal transfers are excluded.', options: { ...common, title: 'Money in, money out', points: labHistory, type: 'bar', series: [
    { key: 'income', name: 'Money in', color: 'var(--chart-in)' }, { key: 'out', name: 'Money out', color: 'var(--chart-out)' },
  ] } },
  { id: 'change', eyebrow: '02 / SIGNED LINE', title: 'Cash change over time', note: 'Accumulated from zero, including a negative month. This is cash change, not an account balance.', options: { ...common, title: 'Cash change over time', points: labCash, series: [
    { key: 'change', name: 'Cash change', color: 'var(--chart-1)' },
  ], references: [{ name: 'Zero', value: 0 }] } },
  { id: 'forecast', eyebrow: '03 / MULTIPLE LINES + GUIDE', title: 'Three ways ahead', note: 'Invented scenarios from the same opening cash. A buffer guide stays visible through both ASCII treatments.', options: { ...common, title: 'Three ways ahead', points: [
    { date: '2026-06-01', steady: 3800000, adjusted: 3800000, cautious: 3800000 },
    { date: '2026-07-01', steady: 4320000, adjusted: 4780000, cautious: 3450000 },
    { date: '2026-08-01', steady: 4840000, adjusted: 5760000, cautious: 3100000 },
    { date: '2026-09-01', steady: 5360000, adjusted: 6740000, cautious: 2750000 },
  ], series: [
    { key: 'adjusted', name: 'Your scenario', color: 'var(--chart-1)' },
    { key: 'steady', name: 'Unchanged', color: 'var(--chart-2)', dashed: true, shape: 'square' },
    { key: 'cautious', name: 'Cautious', color: 'var(--chart-3)', dashArray: '2 5', shape: 'triangle' },
  ], references: [{ name: 'Buffer', value: 3000000, color: 'var(--chart-warning)' }] } },
  { id: 'observations', eyebrow: '04 / ACCOUNT VALUES + GAPS', title: 'Dated account values', note: 'A missing observation leaves a gap. The rendering must not invent a connecting line.', options: { ...common, title: 'Dated account values', points: labHistory.map((point, i) => ({ date: point.date, cash: [4600000, 4200000, null, 3600000, 4100000, 4500000][i], reserve: 2400000 + i * 400000 })), series: [
    { key: 'cash', name: 'Available cash', color: 'var(--chart-1)' },
    { key: 'reserve', name: 'Savings reserve', color: 'var(--chart-4)', dashed: true, shape: 'square' },
  ] } },
];
