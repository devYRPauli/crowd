/* Repeatable tests of the actual inline viewer code. Run: node tests/viewer_final_checks.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample_room.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

function createViewer() {
  const elements = new Map(), network = [];
  const context = new Proxy({measureText: text => ({width: String(text).length * 6})}, {
    get(target, key) { return key in target ? target[key] : () => {}; },
  });
  function element(tag = 'div') {
    const listeners = new Map(), attributes = new Map();
    return {
      tagName: tag.toUpperCase(), value: '', hidden: false, disabled: false,
      textContent: '', children: [], dataset: {}, style: {}, clientWidth: 900, clientHeight: 600,
      classList: {toggle() {}, add() {}, remove() {}},
      getContext: () => context, reportValidity: () => true,
      getBoundingClientRect: () => ({left: 0, top: 0, width: 900, height: 600}),
      setAttribute(key, value) { attributes.set(key, String(value)); },
      getAttribute: key => attributes.get(key),
      addEventListener(kind, callback) {
        if (!listeners.has(kind)) listeners.set(kind, []);
        listeners.get(kind).push(callback);
      },
      async dispatch(kind, detail = {}) {
        for (const callback of listeners.get(kind) || []) {
          await callback({target: this, preventDefault() {}, ...detail});
        }
      },
      click() { return this.dispatch('click'); },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelector() { return element(); },
      insertRow() { const row = element('tr'); this.append(row); return row; },
      insertCell() { const cell = element('td'); this.append(cell); return cell; },
    };
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], element());
  const sandbox = {
    document: {
      getElementById: id => elements.get(id), createElement: element,
      querySelector: selector => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      querySelectorAll: () => [], addEventListener() {},
    },
    window: {devicePixelRatio: 1}, console, Image: class {},
    Number, JSON, Math, Set, Uint8Array, Uint16Array, Float32Array, DataView,
    AbortController, AbortSignal, Blob, URL, TextEncoder, atob, btoa,
    crypto: require('node:crypto').webcrypto,
    Option: function (label, value) { return {label, value}; },
    ResizeObserver: class { observe() {} }, requestAnimationFrame: () => 1,
    setTimeout, clearTimeout,
    fetch: async (url, options) => {
      network.push({url, options});
      throw Error('Unexpected network call in viewer test: ' + url);
    },
    localStorage: {getItem: () => null, setItem() {}},
  };
  vm.createContext(sandbox);
  const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('function currentScenario'));
  assert.ok(inline, 'the actual viewer inline script must exist');
  const startup = inline.lastIndexOf('(async()=>{const version=');
  assert.ok(startup > 0, 'expected initial sample-loading block');
  // Skip only startup I/O and DOM wiring that needs browser layout. All helpers and
  // normal event listeners execute unchanged, including operation confirmation gates.
  const source = inline.slice(0, startup).replace(/\binitializeGuide\(\);/, '');
  vm.runInContext(source, sandbox, {filename: 'static/index.html'});
  const evaluate = code => vm.runInContext(code, sandbox);
  sandbox.fixtureScene = plain(sample);
  evaluate(`
    loadScene(clone(fixtureScene),'Test room');
    fillScenario({n_people:2,arrival_window_s:600,arrival_pattern:'front_loaded',seed:1,horizon_s:.2,mode:'queue'});
    result={run_id:'test-run',metrics:{mean_wait_s:null,max_wait_s:null,walkway_conflict_person_s:0,completed:0},accounting:{not_arrived:2,walking:0,queued:0,in_service:0,done:0},events:{p0:[],p1:[]}};
    lastRun={scene:clone(scene),scenario:currentScenario(),metrics:clone(result.metrics),accounting:clone(result.accounting),cohort_id:'cohort-original',people_hash:'people-original'};
    frames=new Float32Array(8).fill(NaN);frameCount=2;ids=['p0','p1'];people=ids.map(id=>({id,events:[],timeline:{}}));duration=.2;time=.1;
    $('run').disabled=false;$('play').disabled=false;
    if(typeof pinBaseline==='function')pinBaseline();
  `);
  return {
    sandbox, elements, network, evaluate,
    state: () => plain(evaluate(`({scene,scenario:currentScenario(),eventService:$('event-service').value,lastRun,original,result,frames:encodeFrames(frames),time,confirmedAssumptions})`)),
  };
}

function mockMeasuredRun(viewer, overrides = {}) {
  const reply = {...viewer.state().lastRun, ...overrides, run_id: 'candidate-run', events: {p0: [], p1: []}};
  const bytes = new Float32Array(8).fill(NaN).buffer;
  viewer.sandbox.fetch = async (url, options) => {
    viewer.network.push({url, options});
    if (String(url).startsWith('/api/frames/')) return {
      ok: true, headers: {get: name => ({'X-Frame-Count': '2', 'X-Person-Count': '2', 'X-Frame-Dt-S': '.2', 'X-Person-Ids': '["p0","p1"]'})[name]},
      arrayBuffer: async () => bytes,
    };
    return {ok: true, json: async () => plain(reply)};
  };
  viewer.evaluate(`cachedExplanation=async()=>({explanation:'Measured preview explanation.'});`);
  return reply;
}

async function runChecks() {
  const passed = [];
  async function check(label, test) { await test(); passed.push(label); }
  for (const [preset, label] of [
    ['one_volunteer', 'Use one volunteer'],
    ['third_volunteer', 'Use a third volunteer'],
    ['waves_15min', 'Five scheduled arrival waves over 15 minutes'],
  ]) {
    await check(`${preset}: preview preserves measured room and Event fields`, async () => {
      const viewer = createViewer(), before = viewer.state();
      viewer.sandbox.previewArgs = {preset, label};
      viewer.evaluate('previewOperation(previewArgs.preset,previewArgs.label)');
      assert.deepEqual(viewer.state(), before);
      assert.equal(viewer.elements.get('operation-preview').hidden, false);
      assert.equal(viewer.network.length, 0, 'preview must not run or call Astra');
    });
  }
  await check('unconfirmed Astra operating candidate preserves Event fields and playback', async () => {
    const viewer = createViewer();
    viewer.evaluate(`
      original=clone(lastRun);
      candidates=[{...clone(lastRun),index:0,kind:'operations',requires_confirmation:true,rationale:'Change staffing'}];
      candidates[0].scene.targets[0].service_positions=candidates[0].scene.targets[0].service_positions.slice(0,1);
      candidates[0].scenario.arrival_pattern='waves';candidates[0].scenario.arrival_window_s=900;
      delete candidates[0].metrics;delete candidates[0].accounting;
    `);
    const before = viewer.state();
    await viewer.evaluate('selectCandidate(0)');
    assert.deepEqual(viewer.state(), before);
    assert.equal(viewer.network.length, 0, 'unconfirmed candidate must not run');
    assert.match(viewer.elements.get('explanation').textContent, /confirm/i);
  });
  await check('comparison rendering preserves edited Event fields', async () => {
    const viewer = createViewer();
    viewer.evaluate(`original=clone(lastRun);candidates=[{...clone(lastRun),index:0,kind:'layout',rationale:'Move the queue'}];$('arrival').value='900';$('pattern').value='waves';`);
    const before = viewer.state();
    viewer.evaluate('renderComparison()');
    assert.deepEqual(viewer.state(), before);
    assert.equal(viewer.network.length, 0);
  });
  await check('outdated measured run cannot silently apply an operating preview', async () => {
    const viewer = createViewer();
    viewer.evaluate(`if(typeof pinnedBaseline!=='undefined')pinnedBaseline=null;original=null;$('n-people').value='3';`);
    const before = viewer.state();
    viewer.evaluate(`previewOperation('one_volunteer','Use one volunteer')`);
    assert.deepEqual(viewer.state(), before);
    assert.equal(viewer.evaluate('pendingOperation'), null);
    assert.match(viewer.elements.get('api-error').textContent, /run/i);
    assert.equal(viewer.network.length, 0);
  });
  await check('pinned baseline stays unchanged after candidate run; Event fields stay confirmed', async () => {
    const viewer = createViewer();
    assert.equal(viewer.evaluate("typeof pinBaseline"), 'function');
    const baseline = plain(viewer.evaluate('pinnedBaseline'));
    const controls = viewer.state().scenario, eventService = viewer.state().eventService;
    const candidateScene = plain(baseline.scene);
    candidateScene.targets[0].service_positions = candidateScene.targets[0].service_positions.slice(0, 1);
    const candidateScenario = {...baseline.scenario, arrival_pattern: 'waves', arrival_window_s: 900};
    mockMeasuredRun(viewer, {scene: candidateScene, scenario: candidateScenario});
    viewer.sandbox.candidateScene = candidateScene;
    viewer.sandbox.candidateScenario = candidateScenario;
    await viewer.evaluate('executeRun(candidateScene,candidateScenario,revision)');
    assert.deepEqual(viewer.state().scenario, controls, 'a preview must not overwrite Event controls');
    assert.equal(viewer.state().eventService, eventService, 'service-time Event field must remain confirmed');
    assert.deepEqual(plain(viewer.evaluate('displayScenario()')), candidateScenario);
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline')), baseline);
    assert.deepEqual(plain(viewer.evaluate('original')), baseline);
    await viewer.evaluate('runScene({preventDefault(){}})');
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline')), baseline, 'ordinary Run must not replace a baseline');
  });
  await check('chips use pinned baseline after preview, retaining newer Event edits', async () => {
    const viewer = createViewer();
    const baseline = plain(viewer.evaluate('pinnedBaseline'));
    viewer.evaluate(`lastRun={...clone(lastRun),scenario:{...currentScenario(),arrival_pattern:'waves',arrival_window_s:900}};$('n-people').value='7';`);
    const controls = viewer.state().scenario;
    viewer.evaluate(`previewOperation('third_volunteer','Use a third volunteer')`);
    assert.deepEqual(plain(viewer.evaluate('pendingOperation.baseline')), baseline);
    assert.deepEqual(viewer.state().scenario, controls);
    assert.equal(viewer.network.length, 0);
  });
  await check('operating response cannot replace pinned baseline with preview-relative measurements', async () => {
    const viewer = createViewer();
    const baseline = plain(viewer.evaluate('pinnedBaseline'));
    viewer.evaluate(`previewOperation('one_volunteer','Use one volunteer')`);
    const candidateScene = plain(baseline.scene);
    candidateScene.targets[0].service_positions = candidateScene.targets[0].service_positions.slice(0, 1);
    mockMeasuredRun(viewer, {scene: candidateScene, scenario: baseline.scenario,
      baseline_metrics: {...baseline.metrics, max_wait_s: 999}, baseline_accounting: baseline.accounting});
    await viewer.evaluate('confirmOperation()');
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline')), baseline);
    assert.deepEqual(plain(viewer.evaluate('original')), baseline);
    assert.deepEqual(viewer.state().scenario, baseline.scenario);
    const operation = viewer.network.find(call => call.url === '/api/operations');
    assert.ok(operation);
    assert.deepEqual(JSON.parse(operation.options.body).scene, baseline.scene);
  });
  await check('only Make this baseline explicitly repins the measured preview', async () => {
    const viewer = createViewer();
    const baseline = plain(viewer.evaluate('pinnedBaseline'));
    const candidateScene = plain(baseline.scene);
    candidateScene.targets[0].service_positions = candidateScene.targets[0].service_positions.slice(0, 1);
    mockMeasuredRun(viewer, {scene: candidateScene, scenario: baseline.scenario});
    viewer.sandbox.candidateScene = candidateScene;
    await viewer.evaluate('executeRun(candidateScene,currentScenario(),revision)');
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline')), baseline);
    await viewer.evaluate('makeBaseline()');
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline.scene')), candidateScene);
    assert.deepEqual(plain(viewer.evaluate('original')), plain(viewer.evaluate('pinnedBaseline')));
  });
  await check('matching cohort survives layout, staffing and arrival changes', async () => {
    const viewer = createViewer();
    assert.equal(viewer.evaluate('matchingCohort(scene,currentScenario())'), 'cohort-original');
    viewer.evaluate(`
      fixtureCandidate=clone(scene);
      fixtureCandidate.targets[0].service_positions=fixtureCandidate.targets[0].service_positions.slice(0,1);
      fixtureCandidate.targets[0].queue_polyline[1][0]+=.25;
    `);
    assert.equal(viewer.evaluate(`matchingCohort(fixtureCandidate,{...currentScenario(),arrival_pattern:'waves',arrival_window_s:900})`), 'cohort-original');
  });
  await check('population, seed, horizon or service-time changes intentionally start a new cohort', async () => {
    const viewer = createViewer();
    for (const [key, value] of [['n_people', 3], ['seed', 2], ['horizon_s', 10]]) {
      viewer.sandbox.changed = {[key]: value};
      assert.equal(viewer.evaluate('matchingCohort(scene,{...currentScenario(),...changed})'), null, key);
    }
    viewer.evaluate(`fixtureCandidate=clone(scene);fixtureCandidate.targets[0].service_s+=1;`);
    assert.equal(viewer.evaluate('matchingCohort(fixtureCandidate,currentScenario())'), null);
    viewer.evaluate('delete pinnedBaseline.cohort_id');
    assert.equal(viewer.evaluate('matchingCohort(scene,currentScenario())'), null, 'older imported bundles need a fresh cohort');
  });
  await check('ordinary Run forwards the pinned cohort and retains response provenance', async () => {
    const viewer = createViewer();
    mockMeasuredRun(viewer);
    await viewer.evaluate('runScene({preventDefault(){}})');
    const run = viewer.network.find(call => call.url === '/api/run');
    assert.equal(JSON.parse(run.options.body).cohort_id, 'cohort-original');
    assert.equal(viewer.evaluate('lastRun.cohort_id'), 'cohort-original');
    assert.equal(viewer.evaluate('lastRun.people_hash'), 'people-original');
  });
  await check('selected operations use original cohort rather than selected candidate handle', async () => {
    const viewer = createViewer();
    viewer.evaluate(`
      candidates=[{...clone(lastRun),index:0,kind:'operations',cohort_id:'cohort-preview',people_hash:'people-preview',requires_confirmation:true,rationale:'Use one volunteer',patch:[{op:'replace',path:'/scene/targets/0/service_positions',value:scene.targets[0].service_positions.slice(0,1)}]}];
      candidates[0].scene.targets[0].service_positions=candidates[0].scene.targets[0].service_positions.slice(0,1);
    `);
    const candidate = plain(viewer.evaluate('candidates[0]'));
    mockMeasuredRun(viewer, candidate);
    await viewer.evaluate('selectCandidate(0,true)');
    const operation = viewer.network.find(call => call.url === '/api/operations');
    assert.equal(JSON.parse(operation.options.body).cohort_id, 'cohort-original');
    assert.equal(viewer.evaluate('lastRun.cohort_id'), 'cohort-preview');
    assert.equal(viewer.evaluate('original.cohort_id'), 'cohort-original');
    assert.equal(viewer.evaluate('pinnedBaseline.people_hash'), 'people-original');
    viewer.evaluate('makeBaseline()');
    assert.equal(viewer.evaluate('pinnedBaseline.cohort_id'), 'cohort-preview');
    viewer.network.length = 0;
    await viewer.evaluate('runScene({preventDefault(){}})');
    const run = viewer.network.find(call => call.url === '/api/run');
    assert.equal(JSON.parse(run.options.body).cohort_id, 'cohort-preview', 'repinned run must reuse the accepted cohort');
  });
  await check('operating chip and proposal use pinned cohort after another preview', async () => {
    const viewer = createViewer();
    viewer.evaluate(`lastRun.cohort_id='cohort-other-preview';previewOperation('third_volunteer','Use a third volunteer');`);
    mockMeasuredRun(viewer, {cohort_id: 'cohort-original'});
    await viewer.evaluate('confirmOperation()');
    const operation = viewer.network.find(call => call.url === '/api/operations');
    assert.equal(JSON.parse(operation.options.body).cohort_id, 'cohort-original');
    viewer.evaluate(`proposalResponse=async body=>{capturedProposal=clone(body);return {jobId:null,data:{candidates:[],rejected:[]}};};`);
    await viewer.elements.get('propose').click();
    assert.equal(viewer.evaluate('capturedProposal.cohort_id'), 'cohort-original');
    assert.deepEqual(plain(viewer.evaluate('capturedProposal.scenario')), plain(viewer.evaluate('pinnedBaseline.scenario')));
  });
  return passed;
}

module.exports = {createViewer, runChecks};
if (require.main === module) {
  runChecks().then(passed => {
    for (const label of passed) console.log('PASS ' + label);
    console.log(`${passed.length} viewer checks passed`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
