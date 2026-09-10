// Run: node tests/setup_note_checks.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {createViewer}=require(path.join(root,'tests/viewer_final_checks.cjs'));
function checkSetupNote() {
  const viewer=createViewer();
  assert.equal(viewer.evaluate('typeof setupNoteData'),'function','actual inline setupNoteData helper must be present');
  const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/sample_room.json'),'utf8'));
  const snapshot={scene:sample,scenario:{n_people:3,arrival_pattern:'front_loaded',arrival_window_s:600,horizon_s:100},metrics:{mean_wait_s:10,max_wait_s:20,walkway_conflict_person_s:40},accounting:{done:3},events:{p0:[{kind:'joined_queue',time_s:1},{kind:'queue_overflow',time_s:2},{kind:'overflow_end',time_s:3},{kind:'service_start',time_s:5}],p1:[{kind:'joined_queue',time_s:1},{kind:'service_start',time_s:3}],p2:[{kind:'joined_queue',time_s:3},{kind:'service_start',time_s:5}]}};
  const before=structuredClone(snapshot);viewer.sandbox.noteFixture=snapshot;
  const note=viewer.evaluate("setupNoteData(noteFixture,{venueName:'Sample room'})");
  assert.match(note,/SETUP NOTE — Sample room/);
  assert.match(note,/People: 3/);
  assert.match(note,/front loaded over 600 s/);
  assert.match(note,/2 volunteer positions/);
  assert.match(note,/maximum 20 s; mean 10 s/);
  assert.match(note,/Peak line length: 2 people/,'overflow must count once and simultaneous departures first');
  assert.match(note,/\(5, 9\.5\) to \(3, 9\.5\)/,'route coordinates must read as prose');
  assert.doesNotMatch(note,/\[\[/,'JSON coordinate arrays must not appear');
  assert.equal(viewer.evaluate("setupNoteData(noteFixture,{venueName:'Sample room'})"),note);
  assert.deepEqual(snapshot,before);
  viewer.evaluate("noteFixture.scene.walkways.push({id:'second_walkway',poly:noteFixture.scene.walkways[0].poly})");
  assert.match(viewer.evaluate('setupNoteData(noteFixture)'),/largest individual walkway conflict is unavailable/);
  viewer.evaluate('noteFixture.accounting.done=1;noteFixture.metrics.mean_wait_s=null;noteFixture.metrics.max_wait_s=null');
  assert.match(viewer.evaluate('setupNoteData(noteFixture)'),/INCOMPLETE REHEARSAL/);
  assert.match(viewer.evaluate('setupNoteData(noteFixture)'),/maximum unavailable/);
  viewer.evaluate('delete noteFixture.events.p2');
  assert.match(viewer.evaluate('setupNoteData(noteFixture)'),/Peak line length: unavailable/);
  assert.equal(viewer.network.length,0,'setup note must not call Astra, the engine, or any API');
  return '16 inline setup-note assertions passed';
}
module.exports={checkSetupNote};
if(require.main===module){try{console.log(checkSetupNote());}catch(error){console.error(error);process.exitCode=1;}}
