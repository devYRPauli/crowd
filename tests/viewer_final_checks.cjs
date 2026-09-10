/* Repeatable tests of the actual inline viewer code. Run: node tests/viewer_final_checks.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample_room.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

function createViewer({search='?view=2d'}={}) {
  const elements = new Map(), network = [];
  const context = new Proxy({measureText: text => ({width: String(text).length * 6})}, {
    get(target, key) { return key in target ? target[key] : () => {}; },
  });
  function element(tag = 'div') {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return {
      tagName: tag.toUpperCase(), value: '', hidden: false, disabled: false,
      textContent: '', children: [], dataset: {}, style: {}, clientWidth: 900, clientHeight: 600,
      classList: {toggle(key, value) {if(value)classes.add(key);else classes.delete(key);}, add(key) {classes.add(key);}, remove(key) {classes.delete(key);}, contains: key => classes.has(key)},
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
    document: {body:element('body'),
      getElementById: id => elements.get(id), createElement: element,
      querySelector: selector => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      querySelectorAll: () => [], addEventListener() {},
    },
    window: {devicePixelRatio: 1}, location:{search}, URLSearchParams, console, Image: class {},
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
  for(const match of html.matchAll(/<script id="([^"]+)" type="application\/json">([\s\S]*?)<\/script>/g))elements.get(match[1]).textContent=match[2];
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
  const confirmEvent = inline.split('\n').find(line => line.trim().startsWith("$('confirm-event').addEventListener"));
  assert.ok(confirmEvent, 'real Confirm Event handler must exist');
  vm.runInContext(confirmEvent, sandbox, {filename: 'static/index.html:confirm-event'});
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
  await check('validation errors become one concise first message without JSON or Value error prefix', async () => {
    const viewer = createViewer();
    for (const value of [
      'Value error, Queue must stay inside the room.\n Move its tail.',
      {detail: [{loc: ['body', 'scene'], msg: 'Value error, Queue must stay inside the room.\n Move its tail.'}, {msg: 'Second error'}]},
      {errors: ['Value error: Queue must stay inside the room.  Move its tail.']},
      JSON.stringify({detail: {errors: ['Value error, Queue must stay inside the room. Move its tail.']}}),
    ]) {
      viewer.sandbox.errorFixture = value;
      assert.equal(viewer.evaluate('errorLine(errorFixture)'), 'Queue must stay inside the room. Move its tail.');
    }
    assert.equal(viewer.evaluate(`errorLine(new Error('Value error, Keep the door clear.'))`), 'Keep the door clear.');
    assert.equal(viewer.evaluate(`errorLine({unrecognized:'private diagnostic'})`), 'The request could not be completed.');
  });
  await check('step changes clear inline and canvas errors without changing the measured run', async () => {
    const viewer = createViewer();
    const before = viewer.state();
    viewer.evaluate(`fail(Error('Old validation failure'),revision);flashRule('Old validation failure');status('Old validation failure',true);setStep('improve');`);
    assert.equal(viewer.elements.get('api-error').textContent, '');
    assert.equal(viewer.evaluate('ruleCallout'), null);
    assert.equal(viewer.elements.get('status').classList.contains('error'), false);
    assert.deepEqual(viewer.state(), before);
  });
  await check('successful POST clears previous validation while stale POST cannot clear a newer error', async () => {
    const viewer = createViewer();
    viewer.sandbox.fetch = async () => ({ok: true, json: async () => ({scene: sample})});
    viewer.evaluate(`fail(Error('Old error'),revision)`);
    await viewer.evaluate(`api('/api/scene/validate',{scene},revision)`);
    assert.equal(viewer.elements.get('api-error').textContent, '');
    let resolveFetch;
    viewer.sandbox.fetch = () => new Promise(resolve => {resolveFetch = resolve;});
    const pending = viewer.evaluate(`api('/api/scene/validate',{scene},revision)`);
    viewer.evaluate(`invalidate();fail(Error('New error'),revision)`);
    resolveFetch({ok: true, json: async () => ({scene: sample})});
    await assert.rejects(pending, /superseded/);
    assert.equal(viewer.elements.get('api-error').textContent, 'New error');
  });
  await check('invalid drag rolls back and shows the targeted first rule for three seconds', async () => {
    const viewer = createViewer(), before = viewer.state();
    let callback, timeout;
    viewer.sandbox.setTimeout = (fn, milliseconds) => {callback = fn; timeout = milliseconds; return 1;};
    viewer.sandbox.clearTimeout = () => {};
    viewer.sandbox.fetch = async () => ({ok: false, status: 422, json: async () => ({detail: [{msg:'Value error, dining_1 must remain inside the room.'},{msg:'Additional detail'}]})});
    viewer.evaluate(`fixtureCandidate=clone(scene);fixtureCandidate.obstacles[1].poly=fixtureCandidate.obstacles[1].poly.map(p=>[p[0]+50,p[1]]);`);
    await viewer.evaluate('applyDraggedScene(fixtureCandidate,clone(scene),revision)');
    assert.deepEqual(viewer.state(), before);
    assert.equal(viewer.elements.get('api-error').textContent, 'dining_1 must remain inside the room.');
    assert.equal(viewer.evaluate('ruleCallout.text'), 'dining_1 must remain inside the room.');
    assert.deepEqual(plain(viewer.evaluate('ruleCallout.position')), [57, 3]);
    assert.equal(timeout, 3000);
    callback();
    assert.equal(viewer.evaluate('ruleCallout'), null);
  });
  await check('both Event confirmations report invalid fields without silently mutating or requesting', async () => {
    const viewer = createViewer();
    let validityCalls = 0;
    viewer.elements.get('scenario').reportValidity = () => {validityCalls++; return false;};
    viewer.evaluate(`interpreted={scene:clone(scene),scenario:currentScenario(),assumptions:['Review this assumption']};`);
    const before = viewer.state();
    await viewer.elements.get('confirm').click();
    assert.match(viewer.elements.get('scenario-error').textContent, /highlighted Event fields/);
    await viewer.elements.get('confirm-event').click();
    assert.equal(validityCalls, 2);
    assert.deepEqual(viewer.state(), before);
    assert.equal(viewer.network.length, 0);
  });
  await check('incomplete run notice uses displayed run population and survives local import', async () => {
    const viewer = createViewer();
    mockMeasuredRun(viewer);
    viewer.evaluate(`$('n-people').value='7';`);
    await viewer.evaluate('executeRun(scene,pinnedBaseline.scenario,revision)');
    assert.equal(viewer.elements.get('truncated-notice').textContent, 'Only 0 of 2 people finished before the horizon; these numbers are not comparable');
    const bundle = plain(viewer.evaluate('buildBundle()'));
    viewer.evaluate(`clearRun();$('n-people').value='7';`);
    assert.equal(viewer.elements.get('truncated-notice').hidden, true);
    viewer.sandbox.importFixture = bundle;
    await viewer.evaluate('restoreBundle(importFixture)');
    assert.equal(viewer.elements.get('truncated-notice').hidden, false);
    assert.equal(viewer.elements.get('truncated-notice').textContent, 'Only 0 of 2 people finished before the horizon; these numbers are not comparable');
    assert.equal(viewer.network.length, 2, 'only the earlier manual run and frames request are allowed; import must not call the engine');
  });
  await check('either incomplete comparison suppresses green deltas and Astra explanations', async () => {
    const viewer = createViewer();
    viewer.evaluate(`original.metrics.max_wait_s=20;original.accounting.done=1;original.accounting.not_arrived=1;candidates=[{...clone(original),index:0,kind:'layout',rationale:'Move queue'}];candidates[0].accounting.done=2;candidates[0].accounting.not_arrived=0;candidates[0].metrics.max_wait_s=10;explainCalls=0;cachedExplanation=async()=>{explainCalls++;return {explanation:'Should not be called'};};`);
    const cells = element => [element, ...element.children.flatMap(cells)];
    for (const incomplete of ['original', 'candidates[0]']) {
      viewer.evaluate(`original.accounting.done=2;candidates[0].accounting.done=2;${incomplete}.accounting.done=1;renderComparison();`);
      assert.equal(cells(viewer.elements.get('metric-comparison')).some(cell => cell.className === 'better'), false);
      await viewer.evaluate('explainCandidate(candidates[0],revision)');
      assert.equal(viewer.evaluate('explainCalls'), 0);
      assert.match(viewer.elements.get('explanation').textContent, /these numbers are not comparable/);
    }
    viewer.evaluate('original.accounting.done=2;candidates[0].accounting.done=2;renderComparison()');
    assert.equal(cells(viewer.elements.get('metric-comparison')).some(cell => cell.className === 'better'), true, 'complete comparisons retain meaningful delta colors');
    assert.equal(viewer.network.length, 0);
  });
  await check('room names are human-readable in the header, title and saved-room display helper', async () => {
    const viewer = createViewer();
    for (const [filename, expected] of [
      ['venue_v3.json', 'Puck Building, 3rd floor'],
      ['Venue_V3_alternative.json', 'Puck Building, 3rd floor'],
      ['sample_room.json', 'Sample room'],
      ['Sample room', 'Sample room'],
      ['venue_v1_west.json', 'Venue V1 West'],
    ]) {
      viewer.sandbox.nameFixture = filename;
      viewer.evaluate('loadScene(clone(fixtureScene),nameFixture)');
      assert.equal(viewer.elements.get('filename').textContent, expected);
      assert.equal(viewer.evaluate('roomName()'), expected);
      assert.equal(viewer.evaluate('displayRoomName(nameFixture)'), expected);
      assert.match(viewer.elements.get('scene-title').textContent, new RegExp(expected));
    }
    assert.match(html, /id="open-file"[^>]*>Open a room</);
  });
  await check('object labels show readable names and Locked while plan staffing uses correct plurals', async () => {
    const viewer = createViewer(), labels = [];
    viewer.elements.get('room').getContext('2d').fillText = text => labels.push(text);
    const before = plain(viewer.evaluate('scene'));
    viewer.evaluate('rebuildRoom()');
    assert.ok(labels.includes('Dining 1 · Locked'));
    assert.ok(labels.includes('Check In Desk'));
    assert.deepEqual(plain(viewer.evaluate('scene')), before, 'display labels must not rename JSON object IDs');
    viewer.evaluate('scene.targets[0].service_positions=scene.targets[0].service_positions.slice(0,1);updatePlanTitle()');
    assert.match(viewer.elements.get('scene-title').textContent, /1 volunteer$/);
    assert.equal(viewer.evaluate('volunteerLabel(2)'), '2 volunteers');
    assert.equal(viewer.evaluate("humanName('dining_table_left')"), 'Dining Table Left');
  });
  await check('repeat candidate tabs restore exact measured playback and explanation without API calls', async () => {
    const viewer = createViewer(), baseline = plain(viewer.evaluate('pinnedBaseline'));
    viewer.evaluate(`candidates=[{...clone(lastRun),index:0,kind:'layout',rationale:'Move queue'}];candidates[0].scene.targets[0].queue_polyline[1][0]+=.25;renderComparison();`);
    const candidate = plain(viewer.evaluate('candidates[0]'));
    mockMeasuredRun(viewer, candidate);
    await viewer.evaluate('selectCandidate(0)');
    assert.equal(viewer.network.length, 2);
    viewer.evaluate(`new DataView(frames.buffer).setUint32(0,0x7fc01234,true);$('explanation').textContent='Measured candidate explanation.';rememberPlayback();`);
    const bytes = viewer.evaluate('encodeFrames(frames)');
    await viewer.evaluate('selectCandidate(-1)');
    assert.deepEqual(plain(viewer.evaluate('scene')), baseline.scene);
    await viewer.evaluate('selectCandidate(0)');
    assert.equal(viewer.network.length, 2, 'repeated tabs must not call the engine or Astra');
    assert.equal(viewer.evaluate('encodeFrames(frames)'), bytes);
    assert.equal(viewer.elements.get('explanation').textContent, 'Measured candidate explanation.');
    assert.deepEqual(plain(viewer.evaluate('pinnedBaseline')), baseline);
    viewer.evaluate(`for(let i=0;i<5;i++){scene.targets[0].queue_polyline[1][0]+=.1;lastRun.scene=clone(scene);rememberPlayback();}`);
    assert.equal(viewer.evaluate('measuredPlayback.size'), 3, 'playback memory must remain bounded');
  });
  await check('expired cohort never retries automatically; explicit Run samples anew and explicit baseline accepts it', async () => {
    const viewer = createViewer();
    viewer.sandbox.fetch = async (url, options) => {viewer.network.push({url, options});return {ok:false,status:410,json:async()=>({detail:'Cohort expired'})};};
    await viewer.evaluate('runScene({preventDefault(){}})');
    assert.equal(viewer.network.length, 1, 'HTTP 410 must not trigger an automatic retry');
    assert.equal(viewer.evaluate(`expiredCohorts.has('cohort-original')`), true);
    viewer.evaluate(`previewOperation('one_volunteer','Use one volunteer')`);
    assert.equal(viewer.evaluate('pendingOperation'), null);
    assert.equal(viewer.network.length, 1);
    mockMeasuredRun(viewer, {cohort_id:'cohort-fresh'});
    await viewer.evaluate('runScene({preventDefault(){}})');
    assert.equal(JSON.parse(viewer.network[1].options.body).cohort_id, null);
    assert.equal(viewer.evaluate('pinnedBaseline.cohort_id'), 'cohort-original');
    assert.equal(viewer.elements.get('make-baseline').hidden, false);
    viewer.evaluate('makeBaseline()');
    assert.equal(viewer.evaluate('pinnedBaseline.cohort_id'), 'cohort-fresh');
  });
  await check('dirty rehearsal keeps a grey completed tick and exact rerun caption', async () => {
    const viewer = createViewer(), tick = viewer.sandbox.document.createElement('i'), button = viewer.sandbox.document.createElement('button');
    button.dataset.step='rehearse';button.querySelector=()=>tick;
    viewer.sandbox.document.querySelectorAll=selector=>selector==='[data-step]'?[button]:[];
    viewer.evaluate(`completedSteps.add('rehearse');edited('scenario')`);
    assert.equal(viewer.elements.get('rehearsal-dirty').textContent, 'Room changed, run again');
    assert.equal(tick.textContent, '✓');
    assert.equal(tick.classList.contains('dirty'), true);
  });
  await check('slow API owners show Measuring after one second without changing proposal stages', async () => {
    for (const [url, body, owner] of [
      ['/api/run', {}, 'run'], ['/api/propose', {}, 'propose'],
      ['/api/interpret', {brief:'Example'}, 'interpret'],
      ['/api/explain', {rationale:'Write a concise setup note'}, 'setup-note'],
      ['/api/scene/validate', {}, 'confirm-event'], ['/api/operations', {}, 'operation-confirm'],
    ]) {
      const viewer = createViewer(), timers = [];
      viewer.evaluate(`currentStep='event';$('revise-run').disabled=false;$('proposal-stage').textContent='Asking Astra';`);
      viewer.elements.get(owner).textContent='Original action';viewer.elements.get(owner).disabled=false;
      viewer.sandbox.setTimeout=(fn,delay)=>{timers.push({fn,delay});return timers.length;};viewer.sandbox.clearTimeout=()=>{};
      let resolveFetch;viewer.sandbox.fetch=()=>new Promise(resolve=>{resolveFetch=resolve;});
      viewer.sandbox.apiFixture={url,body};
      const pending=viewer.evaluate('api(apiFixture.url,apiFixture.body,revision)');
      assert.equal(viewer.elements.get(owner).disabled,true,url);
      timers.find(timer=>timer.delay===1000).fn();
      assert.equal(viewer.elements.get(owner).textContent,'Measuring…',url);
      assert.equal(viewer.elements.get('proposal-stage').textContent,'Asking Astra');
      resolveFetch({ok:true,json:async()=>({ok:true})});await pending;
      assert.equal(viewer.elements.get(owner).textContent,'Original action',url);
      assert.equal(viewer.elements.get(owner).disabled,false,url);
    }
  });
  await check('candidate tabs disable while measuring and stale completions cannot unlock a newer call', async () => {
    const viewer=createViewer(), descendants=element=>[element,...element.children.flatMap(descendants)],timers=[];
    viewer.sandbox.document.querySelectorAll=selector=>selector==='[data-candidate-index]'?descendants(viewer.elements.get('candidate-tabs')).filter(element=>element.dataset.candidateIndex!==undefined):[];
    viewer.evaluate(`candidates=[{...clone(lastRun),index:0,kind:'layout'}];renderComparison();`);
    viewer.sandbox.setTimeout=(fn,delay)=>{timers.push({fn,delay});return timers.length;};viewer.sandbox.clearTimeout=()=>{};
    const old=viewer.evaluate('revision');viewer.evaluate('setCandidateMeasuring(0,revision)');
    assert.equal(viewer.sandbox.document.querySelectorAll('[data-candidate-index]').every(button=>button.disabled),true);
    timers.find(timer=>timer.delay===1000).fn();
    assert.equal(viewer.sandbox.document.querySelectorAll('[data-candidate-index]').find(button=>button.dataset.candidateIndex==='0').textContent,'Measuring…');
    viewer.evaluate('invalidate();setCandidateMeasuring(0,revision)');viewer.sandbox.oldRevision=old;viewer.evaluate('stopCandidateMeasuring(oldRevision)');
    assert.equal(viewer.sandbox.document.querySelectorAll('[data-candidate-index]').every(button=>button.disabled),true);
    viewer.evaluate('stopCandidateMeasuring(revision)');
    assert.equal(viewer.sandbox.document.querySelectorAll('[data-candidate-index]').every(button=>!button.disabled),true);
  });
  await check('Dinner call controls preserve mode and wave settings; legacy Arrival scenarios get defaults', async () => {
    const viewer=createViewer();
    viewer.evaluate(`fillScenario({n_people:2,arrival_window_s:600,arrival_pattern:'front_loaded',seed:1,horizon_s:.2,mode:'dinner_call',wave_count:4,wave_gap_s:120})`);
    assert.equal(viewer.evaluate('currentScenario().mode'),'dinner_call');
    assert.equal(viewer.evaluate('currentScenario().wave_count'),4);
    assert.equal(viewer.evaluate('currentScenario().wave_gap_s'),120);
    assert.equal(viewer.evaluate('scenarioTiming(currentScenario())'),'front-loaded dinner releases over 600 s');
    const dinnerNote=viewer.evaluate(`setupNoteData({...lastRun,scenario:currentScenario(),events:result.events})`);
    assert.match(dinnerNote,/Dinner releases: front loaded over 600 s/);
    assert.doesNotMatch(dinnerNote,/4 table calls/);
    viewer.evaluate('validScenario(currentScenario())');
    viewer.evaluate(`fillScenario({n_people:2,arrival_window_s:600,arrival_pattern:'front_loaded',seed:1,horizon_s:.2,mode:'queue'})`);
    assert.equal(viewer.evaluate('currentScenario().wave_count'),3);
    assert.equal(viewer.evaluate('currentScenario().wave_gap_s'),300);
    assert.throws(()=>viewer.evaluate('validScenario({...currentScenario(),wave_count:0})'),/table call count/);
    assert.throws(()=>viewer.evaluate('validScenario({...currentScenario(),wave_gap_s:0})'),/table call gap/);
  });
  await check('Dinner call bundle restores waiting and released anchors, seated accounting and posture metadata', async () => {
    const viewer=createViewer(),bundle=plain(viewer.evaluate('buildBundle()'));
    bundle.scenario={...bundle.scenario,mode:'dinner_call',wave_count:3,wave_gap_s:300};bundle.original=null;
    bundle.accounting={seated:1,walking:1,queued:0,in_service:0,done:0};
    bundle.playback.events={
      p0:[{kind:'initially_seated',time_s:0,position:[2,3],placement_kind:'seat',seat_group:'table_a'},{kind:'released',time_s:.1,position:[2,3],seat_group:'table_a'}],
      p1:[{kind:'initially_seated',time_s:0,position:[4,5],placement_kind:'standing',seat_group:'table_b'}],
    };
    bundle.playback.frames_base64=Buffer.from(new Float32Array([2,3,4,5,2,3,4,5]).buffer).toString('base64');bundle.playback.time_s=.15;
    viewer.sandbox.dinnerFixture=bundle;await viewer.evaluate('restoreBundle(dinnerFixture)');
    assert.equal(viewer.evaluate('stateAt(people[0],.05)'),'seated');
    assert.equal(viewer.evaluate('stateAt(people[0],.15)'),'walking','released people stay visible before native admission');
    assert.equal(viewer.evaluate('stateAt(people[1],.15)'),'seated');
    assert.deepEqual(plain(viewer.evaluate("personPosition(0,'walking')")),[2,3]);
    assert.match(viewer.elements.get('accounting').textContent,/seated 1/);
    assert.equal(viewer.evaluate('currentScenario().mode'),'dinner_call');assert.equal(viewer.elements.get('experimental-notice').hidden,false);
    const roundTrip=plain(viewer.evaluate('buildBundle()'));
    assert.deepEqual(roundTrip.accounting,bundle.accounting);
    assert.deepEqual(roundTrip.playback,bundle.playback);
    viewer.evaluate(`watchActive=true;watchView={setScene(){},setEditingEnabled(){},update(value){watchPayload=value;},render(){}};drawn=[{i:0,state:'seated'},{i:1,state:'seated'}];renderWatch();`);
    assert.equal(viewer.evaluate('watchPayload.people[0].placement_kind'),'seat');
    assert.equal(viewer.evaluate('watchPayload.people[1].placement_kind'),'standing');
    assert.equal(viewer.network.length,0);
    await viewer.elements.get('judge-waves').click();
    assert.equal(viewer.evaluate('pendingOperation.label'),'Three table calls, 300 seconds apart');
    const invalid=plain(bundle);invalid.playback.events.p0=[...invalid.playback.events.p0].reverse();viewer.sandbox.badDinner=invalid;
    const before=viewer.state();await assert.rejects(viewer.evaluate('restoreBundle(badDinner)'),/event kind\/time\/order|out-of-order lifecycle/);assert.deepEqual(viewer.state(),before);
  });
  await check('legacy Arrival operating snapshots never emit forbidden dinner-wave patches', async () => {
    const viewer=createViewer();
    viewer.evaluate(`legacyCandidate=clone(original);delete legacyCandidate.scenario.wave_count;delete legacyCandidate.scenario.wave_gap_s;legacyCandidate.scene.targets[0].service_positions=legacyCandidate.scene.targets[0].service_positions.slice(0,1);`);
    const patch=plain(viewer.evaluate('operationPatch(legacyCandidate)'));
    assert.deepEqual(patch.map(operation=>operation.path),['/scene/targets/0/service_positions']);
    viewer.evaluate(`original.scenario.mode='dinner_call';legacyCandidate.scenario.mode='dinner_call';`);
    assert.deepEqual(plain(viewer.evaluate('operationPatch(legacyCandidate)')).map(operation=>operation.path),['/scene/targets/0/service_positions']);
    viewer.evaluate('legacyCandidate.scenario.wave_count=4');
    assert.equal(plain(viewer.evaluate('operationPatch(legacyCandidate)')).find(operation=>operation.path==='/scenario/wave_count').value,4);
  });
  await check('Demo preloads legal Puck layout and curated coffee examples reset their scenario and baseline', async () => {
    const viewer=createViewer({search:'?demo=1&view=2d'});
    viewer.evaluate('initializeDemo()');
    assert.equal(viewer.elements.get('filename').textContent,'Puck Building, 3rd floor');
    assert.deepEqual(plain(viewer.evaluate('scene.layout_options.map(option=>option.id)')),['line_in_aisle','line_south_corridor']);
    assert.equal(viewer.evaluate('currentScenario().mode'),'queue');assert.equal(viewer.evaluate('currentScenario().n_people'),120);assert.equal(viewer.elements.get('experimental-notice').hidden,true);
    assert.match(viewer.elements.get('brief').value,/120 guests arrive for the event/);
    assert.match(viewer.elements.get('constraints').value,/central aisle clear/);
    assert.equal(viewer.elements.get('run').disabled,true);
    for(const id of ['open_coffee_room','furnished_coffee_room']){
      viewer.sandbox.exampleId=id;viewer.evaluate('loadDemoRoom(exampleId)');
      assert.equal(viewer.evaluate('pinnedBaseline'),null);assert.equal(viewer.evaluate('confirmedScenario'),null);
      assert.equal(viewer.evaluate('currentScenario().mode'),'queue');assert.equal(viewer.evaluate('currentScenario().n_people'),60);
      assert.equal(viewer.evaluate('currentScenario().arrival_pattern'),'uniform');assert.equal(viewer.evaluate('currentScenario().arrival_window_s'),300);
      assert.equal(viewer.evaluate('scene.targets[0].service_s'),15);
      assert.match(viewer.elements.get('brief').value,/60 guests arrive uniformly/);
    }
    const catalog=JSON.parse(viewer.elements.get('room-catalog').textContent);
    assert.ok(catalog.some(room=>room.filename==='open_coffee_room.json'));
    assert.ok(catalog.some(room=>room.filename==='furnished_coffee_room.json'));
    assert.equal(viewer.network.length,0);
  });
  await check('Demo is read-only, hides Plan and Candidate B, and uses one visible Confirm', async () => {
    const viewer=createViewer({search:'?demo=1&view=2d'});viewer.evaluate('initializeDemo()');
    assert.equal(await viewer.evaluate('editIn3D({scene:null})'),false);
    await viewer.elements.get('room').dispatch('pointerdown',{button:0,clientX:100,clientY:100});
    await viewer.evaluate('mutateRoom(null,"Unwanted edit")');assert.equal(viewer.network.length,0);
    viewer.evaluate(`original=clone(lastRun);candidates=[{...clone(lastRun),index:0,kind:'layout'},{...clone(lastRun),index:1,kind:'layout'}];renderComparison();`);
    const descendants=element=>[element,...element.children.flatMap(descendants)];
    const tabs=descendants(viewer.elements.get('candidate-tabs')).filter(element=>element.dataset.candidateIndex!==undefined);
    assert.deepEqual(tabs.map(tab=>tab.dataset.candidateIndex),['-1','0']);assert.equal(tabs[0].textContent,'Original');
    viewer.evaluate(`setStep('plan')`);assert.equal(viewer.evaluate('currentStep'),'improve');
    viewer.evaluate(`setStep('event');interpreted={scene:null,scenario:currentScenario(),assumptions:['Confirm these dinner assumptions']};`);
    viewer.sandbox.fetch=async(url,options)=>{viewer.network.push({url,options});return {ok:true,json:async()=>({scene:JSON.parse(options.body).scene})};};
    await viewer.elements.get('confirm').click();for(let i=0;i<15;i++)await Promise.resolve();
    assert.equal(viewer.evaluate('currentStep'),'rehearse');assert.equal(viewer.elements.get('run').disabled,false);
    assert.equal(viewer.network.length,1);assert.equal(viewer.network[0].url,'/api/scene/validate');
    assert.match(html,/body\.demo \[data-step="plan"\]/);assert.match(html,/body\.demo #comparison-provenance/);
  });
  await check('Demo R restores retained Original without requests and camera shortcuts work on focused buttons', async () => {
    const viewer=createViewer({search:'?demo=1&view=2d'}),before=viewer.state();
    viewer.evaluate(`scene.targets[0].service_positions=scene.targets[0].service_positions.slice(0,1);lastRun.scene=clone(scene);activeCandidate=0;time=.2;resetDemo();`);
    assert.deepEqual(viewer.state().scene,before.scene);assert.equal(viewer.evaluate('time'),0);assert.equal(viewer.network.length,0);
    const cameras=[];viewer.sandbox.watchViewMock={setPreset:value=>cameras.push(value)};viewer.evaluate('watchView=watchViewMock');
    let prevented=0;for(const key of ['1','2','3']){viewer.sandbox.keyFixture={key,target:{tagName:'BUTTON'},preventDefault(){prevented++;},stopImmediatePropagation(){}};viewer.evaluate('demoShortcut(keyFixture)');}
    assert.deepEqual(cameras,['plan','door','buffet']);assert.equal(prevented,3);
    viewer.sandbox.keyFixture={key:'1',target:{tagName:'TEXTAREA'},preventDefault(){throw Error('Typing must not trigger shortcuts');},stopImmediatePropagation(){}};viewer.evaluate('demoShortcut(keyFixture)');
    assert.equal(cameras.length,3);
    viewer.sandbox.keyFixture={key:' ',code:'Space',target:{tagName:'BUTTON'},preventDefault(){},stopImmediatePropagation(){}};viewer.evaluate('demoShortcut(keyFixture)');assert.equal(viewer.evaluate('playing'),true);
    assert.equal(viewer.network.length,0);
  });
  await check('Demo assumptions wrap in editable expanding textareas while normal mode keeps inputs', async () => {
    for(const [search,tag] of [['?demo=1&view=2d','TEXTAREA'],['?view=2d','INPUT']]){
      const viewer=createViewer({search});viewer.sandbox.assumptionFixture={assumptions:['A long receipt with service time and table release assumptions. '.repeat(12)]};
      viewer.evaluate('renderAssumptions(assumptionFixture)');
      const field=viewer.elements.get('assumptions').children[0].children[0];assert.equal(field.tagName,tag);
      if(tag==='TEXTAREA'){assert.equal(field.rows,3);assert.equal(field.wrap,'soft');}
      field.value='Edited assumption with a second line\nfor the confirmed plan.';await field.dispatch('input');
      assert.equal(viewer.evaluate('assumptionFixture.assumptions[0]'),field.value);
      if(tag==='TEXTAREA')assert.ok(parseFloat(field.style.height)>=64);
    }
  });
  await check('Arrival completion requires exiting and removes exited people while preserving legacy playback', async () => {
    const viewer=createViewer(),bundle=plain(viewer.evaluate('buildBundle()'));
    bundle.original=null;bundle.metrics.completed=1;bundle.accounting={not_arrived:1,walking:0,queued:0,in_service:0,done:1};
    const lifecycle=['spawned','joined_queue','service_start','service_end','reached_destination','exited'];
    bundle.playback.events.p0=lifecycle.map((kind,i)=>({kind,time_s:i*.02,position:[2+i,3]}));bundle.playback.time_s=.15;
    viewer.sandbox.lifecycleBundle=bundle;await viewer.evaluate('restoreBundle(lifecycleBundle)');
    assert.equal(viewer.evaluate('stateAt(people[0],.09)'),'walking');
    assert.equal(viewer.evaluate('stateAt(people[0],.15)'),'done');
    assert.equal(viewer.evaluate("personPosition(0,'done')"),null);
    assert.deepEqual(plain(viewer.evaluate('people[0].timeline.exited.position')),[7,3]);
    assert.deepEqual(plain(viewer.evaluate('buildBundle().playback')),bundle.playback);
    const before=viewer.state();const invalid=plain(bundle);invalid.playback.events.p0=invalid.playback.events.p0.filter(e=>e.kind!=='reached_destination');viewer.sandbox.badLifecycle=invalid;
    await assert.rejects(viewer.evaluate('restoreBundle(badLifecycle)'),/exit before destination/);assert.deepEqual(viewer.state(),before);
    const duplicate=plain(bundle);duplicate.playback.events.p0.push({kind:'exited',time_s:.15,position:[7,3]});viewer.sandbox.badLifecycle=duplicate;
    await assert.rejects(viewer.evaluate('restoreBundle(badLifecycle)'),/duplicate terminal/);assert.deepEqual(viewer.state(),before);
    const legacy=plain(bundle);legacy.playback.events.p0=legacy.playback.events.p0.slice(0,4).concat({kind:'seated',time_s:.1,position:[8,3]});viewer.sandbox.legacyLifecycle=legacy;await viewer.evaluate('restoreBundle(legacyLifecycle)');
    assert.deepEqual(plain(viewer.evaluate("personPosition(0,'done')")),[8,3]);assert.equal(viewer.network.length,0);
  });
  await check('Dinner returns stay visible at measured seat positions and send seated or standing Watch poses', async () => {
    const viewer=createViewer(),bundle=plain(viewer.evaluate('buildBundle()'));
    bundle.original=null;bundle.scenario.mode='dinner_call';bundle.metrics.completed=2;bundle.accounting={seated:0,walking:0,queued:0,in_service:0,done:2};
    for(let i=0;i<2;i++){
      const placement_kind=i?'standing':'seat',seat_group='table_'+i,position=[2+i*2,3];
      bundle.playback.events['p'+i]=[{kind:'initially_seated',time_s:0,position,placement_kind,seat_group},...['released','spawned','joined_queue','service_start','service_end'].map((kind,j)=>({kind,time_s:(j+1)*.01,position})),{kind:'returned_to_seat',time_s:.1,position:[position[0]+.1,3],seat_position:position,placement_kind,seat_group}];
    }
    bundle.playback.frames_base64=Buffer.from(new Float32Array([2,3,4,3,2.5,3.25,4.5,3.25]).buffer).toString('base64');bundle.playback.time_s=.15;
    viewer.sandbox.returnFixture=bundle;await viewer.evaluate('restoreBundle(returnFixture)');
    assert.equal(viewer.evaluate('stateAt(people[0],.08)'),'walking');assert.equal(viewer.evaluate('stateAt(people[0],.15)'),'done');
    const measuredPosition=plain(viewer.evaluate("personPosition(0,'done')"));
    assert.ok(Math.abs(measuredPosition[0]-2.375)<1e-7);assert.ok(Math.abs(measuredPosition[1]-3.1875)<1e-7,'returned guests follow subsequent measured frames');
    viewer.evaluate(`watchActive=true;watchView={setScene(){},setEditingEnabled(){},update(value){watchPayload=value;},render(){}};drawn=[{i:0,state:'done'},{i:1,state:'done'}];renderWatch();`);
    assert.equal(viewer.evaluate('watchPayload.people[0].seated'),true);assert.equal(viewer.evaluate('watchPayload.people[1].seated'),false);
    assert.deepEqual(plain(viewer.evaluate('buildBundle().playback')),bundle.playback);
    viewer.evaluate('savedFrames=frames.slice();frames.fill(NaN)');assert.deepEqual(plain(viewer.evaluate("personPosition(0,'done')")),[2.1,3]);viewer.evaluate('frames=savedFrames');
    const before=viewer.state(),invalid=plain(bundle);delete invalid.playback.events.p0.at(-1).seat_position;viewer.sandbox.badReturn=invalid;
    await assert.rejects(viewer.evaluate('restoreBundle(badReturn)'),/returned seat metadata/);assert.deepEqual(viewer.state(),before);assert.equal(viewer.network.length,0);
  });
  await check('Room viewport reserves palette and transport space without changing Demo palette visibility', async () => {
    const viewer=createViewer();viewer.evaluate("setStep('room')");assert.equal(viewer.sandbox.document.body.dataset.step,'room');
    viewer.evaluate("setStep('rehearse')");assert.equal(viewer.sandbox.document.body.dataset.step,'rehearse');
    assert.match(html,/body:not\(\.demo\)\[data-step="room"\] \.canvas-wrap\{height:max\(400px,calc\(100vh - 425px\)\)\}/);
    assert.match(html,/\.canvas-wrap,body\.demo \.canvas-wrap\{height:max\(400px,calc\(100vh - 340px\)\)\}/);
  });
  await check('Staffing labels use actual population and incomplete rows cannot justify wait or cost claims', async () => {
    const viewer=createViewer();viewer.sandbox.staffRoom={n:60,width:18,depth:12,baseCount:2};
    viewer.sandbox.staffRows=[{count:1,metrics:{completed:30,mean_wait_s:8,max_wait_s:15}},{count:2,metrics:{completed:60,mean_wait_s:100,max_wait_s:150}},{count:3,metrics:{completed:60,mean_wait_s:50,max_wait_s:90}},{count:4,metrics:{completed:59,mean_wait_s:10,max_wait_s:20}}];
    viewer.evaluate('renderStaffing(staffRows,staffRoom)');
    assert.match(viewer.elements.get('staffing-title').textContent,/60-person/);
    const note=viewer.elements.get('staffing-note').textContent;assert.match(note,/30 of 60 guests completed/);assert.match(note,/59 of 60 guests completed/);assert.match(note,/not comparable/);assert.doesNotMatch(note,/pays|paying|cuts|fourth provides|serves|served/);assert.doesNotMatch(viewer.elements.get('staffing-rows').innerHTML,/class="chosen"/);
    viewer.sandbox.staffRows[3].metrics={completed:60,mean_wait_s:70,max_wait_s:110};viewer.evaluate('renderStaffing(staffRows,staffRoom)');
    assert.match(viewer.elements.get('staffing-note').textContent,/fourth increases mean wait by 20 s/);assert.doesNotMatch(viewer.elements.get('staffing-rows').innerHTML,/class="chosen"/);
    assert.equal(viewer.network.length,0);
  });
  await check('Autoplay captions compare the measured operating run with Original and guard incomplete runs', async () => {
    const viewer=createViewer();viewer.evaluate(`captionBase={scenario:{n_people:60},accounting:{done:60},metrics:{mean_wait_s:100,walkway_conflict_person_s:100}};captionCandidate={scenario:{n_people:60},accounting:{done:60},metrics:{mean_wait_s:120,walkway_conflict_person_s:50}};`);
    const caption=viewer.evaluate('operationCaption(captionBase,captionCandidate)');assert.match(caption,/versus Original/);assert.match(caption,/20% higher/);assert.match(caption,/50% lower/);assert.doesNotMatch(caption,/beats/);
    viewer.evaluate('captionCandidate.accounting.done=59');assert.match(viewer.evaluate('operationCaption(captionBase,captionCandidate)'),/Only 59 of 60.*not comparable/);assert.equal(viewer.network.length,0);
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
