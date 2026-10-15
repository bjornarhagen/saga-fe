const defaultSettings = {
  scopes: ['cash', 'cash-reserve-investments'],
  methods: ['scenario'],
  startingGuides: false,
  fundingLimits: false,
  points: true,
};

// These controls change the chart presentation, never account roles or balances.
export function createForecastChartControls({ onChange }) {
  const root = document.getElementById('forecast-chart-controls');
  const $ = id => document.getElementById(id);
  const methodOptions = $('forecast-chart-method-options');
  const scopeInputs = [...root.querySelectorAll('[name="forecast-chart-scope"]')];
  const methodInputs = new Map();
  const booleanInputs = new Map([
    ['startingGuides', $('forecast-chart-starting-guides')],
    ['fundingLimits', $('forecast-chart-funding-limits')],
    ['points', $('forecast-chart-points')],
  ]);
  let settings = { ...defaultSettings };
  let availableMethods = [];

  function error(message = '') {
    $('forecast-chart-layer-error').textContent = message;
    $('forecast-chart-layer-error').hidden = !message;
  }

  function changed(patch) {
    error();
    settings = { ...settings, ...patch };
    onChange(patch);
  }

  function renderMethods(methods) {
    const nextMethods = [{ id: 'scenario', name: 'Your scenario' }, ...methods.filter(method => method.id !== 'scenario')];
    availableMethods = nextMethods;
    const keep = new Set();
    for (const method of nextMethods) {
      keep.add(method.id);
      let row = methodInputs.get(method.id);
      if (!row) {
        const label = document.createElement('label');
        label.className = 'forecast-chart-layer-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'forecast-chart-method';
        input.value = method.id;
        const copy = document.createElement('span');
        const name = document.createElement('span');
        const reason = document.createElement('small');
        copy.append(name, reason);
        label.append(input, copy);
        row = { label, input, name, reason };
        methodInputs.set(method.id, row);
        methodOptions.append(label);
      }
      row.name.textContent = method.name;
      row.input.checked = settings.methods.includes(method.id);
      row.input.disabled = method.id !== 'scenario' && !!method.reason;
      row.reason.textContent = method.reason || '';
      row.reason.hidden = !method.reason;
    }
    for (const [id, row] of methodInputs) {
      if (keep.has(id)) continue;
      row.label.remove();
      methodInputs.delete(id);
    }
  }

  root.addEventListener('change', event => {
    const input = event.target;
    if (input.name === 'forecast-chart-scope') {
      const scopes = scopeInputs.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
      if (!scopes.length) {
        input.checked = true;
        error('Keep at least one funds combination visible.');
        return;
      }
      changed({ scopes });
    } else if (input.name === 'forecast-chart-method') {
      const methods = [...methodInputs.values()].filter(row => row.input.checked).map(row => row.input.value);
      const hasAvailableMethod = availableMethods.some(method => methods.includes(method.id) && (method.id === 'scenario' || !method.reason));
      if (!hasAvailableMethod) {
        input.checked = true;
        error('Keep at least one available projected method visible.');
        return;
      }
      changed({ methods });
    } else {
      for (const [key, checkbox] of booleanInputs) {
        if (input === checkbox) changed({ [key]: checkbox.checked });
      }
    }
  });

  return {
    setData({ settings: nextSettings, methods = [], seriesCount = 0, notes = [] }) {
      settings = { ...defaultSettings, ...nextSettings };
      for (const input of scopeInputs) input.checked = settings.scopes.includes(input.value);
      for (const [key, input] of booleanInputs) input.checked = settings[key];
      renderMethods(methods);
      const count = Number.isSafeInteger(seriesCount) && seriesCount >= 0 ? seriesCount : 0;
      $('forecast-chart-line-count').textContent = `${count} chart series`;
      $('forecast-chart-crowded-note').hidden = count <= 8;
      $('forecast-chart-crowded-note').textContent = count > 8 ? `${count} series are selected. Fewer funds combinations or projected methods can make overlapping paths easier to read.` : '';
      const noteText = (Array.isArray(notes) ? notes : [notes]).filter(Boolean).join(' ');
      $('forecast-chart-layer-notes').textContent = noteText;
      $('forecast-chart-layer-notes').hidden = !noteText;
    },
  };
}
