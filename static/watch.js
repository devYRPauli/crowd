// Presentation only: all coordinates and states come from the existing 2D playback.
// Three.js r180 is pinned; no model, simulation, frame fetch, or private simulation clock.
const THREE_URL = 'https://esm.sh/three@0.180.0';
const ORBIT_URL = 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';
const GLTF_URL = 'https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
const STATE_COLORS = {seated:'#78939e',walking:'#4479b4',queued:'#cf9d31',in_service:'#8a60ae',overflow:'#d25242',done:'#3e926d'};
const FOOTPRINTS = {round_table:[1.6,1.6],chair:[.5,.5],banquette:[2,.8],buffet:[1.5,.8],screen:[2.4,.6],plant:[.5,.5]};

export async function createWatch(host,{onEdit=async()=>false,onSelectPerson=()=>{},onError=()=>{}}={}) {
  let THREE, OrbitControls;
  try {
    const modules = await Promise.all([import(THREE_URL), import(ORBIT_URL)]);
    THREE = modules[0]; OrbitControls = modules[1].OrbitControls;
  } catch (error) {
    throw new Error('Watch could not load its 3D renderer from the CDN. The 2D rehearsal remains available.', {cause:error});
  }
  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'}); }
  catch (error) { throw new Error('Watch requires WebGL2. The 2D rehearsal remains available.', {cause:error}); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor('#edf1eb');
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of the same measured rehearsal');
  renderer.domElement.tabIndex=0;
  host.appendChild(renderer.domElement);
  const world = new THREE.Scene(), room = new THREE.Group();
  world.add(room);
  world.add(new THREE.AmbientLight(0xffffff, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(-8, 22, -12); world.add(sun);
  const perspectiveCamera = new THREE.PerspectiveCamera(48, 1, .05, 500);
  const planCamera = new THREE.OrthographicCamera(-15,15,10,-10,.05,500);
  let camera=planCamera;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 1.5;
  controls.maxPolarAngle = Math.PI / 2 - .025;
  controls.screenSpacePanning = false;
  let visible = false, disposed = false, currentScene = null, currentBounds = [0,0,24,14];
  let preset = 'plan', mode='plan', capacity = 0, bodies, heads, cylindersOnly = false;
  let editingEnabled=false,tool='move',selected=null,drag=null,pendingEdit=null,editEpoch=0;
  let renderRequest=0,renderCalls=0,cameraTransition=null,layoutTransition=null,viewWidth=800,viewHeight=500;
  let vertexLayer=null,gridMesh=null,ghost=null,hoverOutline=null,selectionOutline=null,ghostModel=null,ghostKind=null,ghostGeneration=0;
  const obstacleVisuals=new Map(),queueVisuals=[],queueTails=[],overflowVisuals=[],ownedTextures=new Set(),instancePeople=[];
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),floorPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0),floorHit=new THREE.Vector3();
  let heatMesh = null, heatTexture = null, lastHeatVersion = Symbol(), lastHeatBounds = '';
  let lastPeople = [], lastTime = 0, sceneGeneration = 0, loaderPromise;
  let personAssetMeshes = [], personAssetGeometry = [];
  const assetCache = new Map(), assetSources = new Set(), personPhases = new Map();
  const assetStatus = {person:'Loading person asset; capsules remain visible.',furniture:{}};
  const transform = new THREE.Object3D();
  const colors = Object.fromEntries(Object.entries(STATE_COLORS).map(([key,value]) => [key,new THREE.Color(value)]));
  const bodyGeometry = new THREE.CylinderGeometry(.175, .175, 1.35, 8, 1);
  const headGeometry = new THREE.SphereGeometry(.175, 8, 6);
  const personMaterial = new THREE.MeshStandardMaterial({color:0xffffff,roughness:.9});
  function render() {if(visible&&!disposed&&!renderRequest)renderRequest=requestAnimationFrame(drawFrame);}
  function drawFrame(now) {
    renderRequest=0;if(!visible||disposed)return;
    if(cameraTransition){
      const fraction=Math.min(1,(now-cameraTransition.started)/400),eased=fraction*fraction*(3-2*fraction);
      camera.position.lerpVectors(cameraTransition.from,cameraTransition.to,eased);
      controls.target.lerpVectors(cameraTransition.fromTarget,cameraTransition.toTarget,eased);
      controls.update();if(fraction===1)cameraTransition=null;
    }
    if(layoutTransition){
      if(layoutTransition.started===null)layoutTransition.started=now;
      const elapsed=now-layoutTransition.started,fraction=Math.min(1,elapsed/1200),eased=fraction*fraction*(3-2*fraction),fade=Math.min(1,elapsed/3000);
      for(const step of layoutTransition.moves)step(eased);
      for(const highlight of layoutTransition.highlights)highlight.material.opacity=highlight.userData.opacity*(1-fade);
      if(fade===1)endLayoutTransition();
    }
    renderer.render(world,camera);renderCalls++;
    if(cameraTransition||layoutTransition)render();
  }
  controls.addEventListener('change', render);

  function loader() {return loaderPromise ||= import(GLTF_URL).then(module=>new module.GLTFLoader());}
  function releaseSource(source) {
    const geometries=new Set(),materials=new Set(),textures=new Set();
    source.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)for(const m of Array.isArray(object.material)?object.material:[object.material])materials.add(m);});
    for(const m of materials)for(const value of Object.values(m))if(value?.isTexture)textures.add(value);
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
    textures.forEach(texture=>{texture.dispose();texture.image?.close?.();});
  }
  function asset(name, extension='gltf') {
    if(!assetCache.has(name))assetCache.set(name,loader().then(load=>load.loadAsync(`/static/assets/pick/${name}.${extension}`)).then(gltf=>{
      if(disposed){releaseSource(gltf.scene);throw new Error('Watch was disposed during asset loading.');}
      gltf.scene.updateMatrixWorld(true);assetSources.add(gltf.scene);return gltf.scene;
    }));
    return assetCache.get(name);
  }
  function furnitureType(obstacle) {
    const kind=`${obstacle.kind} ${obstacle.id}`.toLowerCase();
    if(/buffet|desk|check.?in|counter/.test(kind))return {name:'counter',height:.9};
    if(/banquette|seating|bench|sofa/.test(kind))return {name:'sofa_long',height:.9};
    if(/screen/.test(kind))return {name:'screen',height:1.2,bottom:.9};
    if(/plant|cactus/.test(kind))return {name:'plant',height:1.2};
    if(/chair/.test(kind))return {name:'chair',height:.9};
    if(/round|dining|table/.test(kind))return {name:'table_round',height:.75};
    return null;
  }
  function decorateObstacle(obstacle, fallback, generation) {
    const type=furnitureType(obstacle);if(!type)return;
    assetStatus.furniture[obstacle.id]='Loading asset; primitive remains visible.';
    asset(type.name).then(source=>{
      if(disposed||generation!==sceneGeneration)return;
      const clone=source.clone(true),group=new THREE.Group();group.add(clone);
      const [x0,y0,x1,y1]=bounds(obstacle.poly),width=x1-x0,depth=y1-y0;
      let bbox=new THREE.Box3().setFromObject(clone),size=bbox.getSize(new THREE.Vector3());
      if((width<depth)!==(size.x<size.z)){clone.rotation.y+=Math.PI/2;clone.updateMatrixWorld(true);bbox=new THREE.Box3().setFromObject(clone);size=bbox.getSize(new THREE.Vector3());}
      if(Math.min(size.x,size.y,size.z)<=0)throw new Error('Asset has an empty bounding box.');
      const center=bbox.getCenter(new THREE.Vector3());
      clone.position.sub(new THREE.Vector3(center.x,bbox.min.y,center.z));
      clone.traverse(object=>{if(object.isMesh){object.geometry=object.geometry.clone();object.material=Array.isArray(object.material)?object.material.map(m=>m.clone()):object.material.clone();object.castShadow=false;object.receiveShadow=false;}});
      group.scale.set(width/size.x,type.height/size.y,depth/size.z);
      group.position.set((x0+x1)/2,type.bottom||0,-(y0+y1)/2);
      const visual=obstacleVisuals.get(obstacle.id);
      if(visual){group.position.sub(new THREE.Vector3(visual.origin[0],0,-visual.origin[1]));visual.group.add(group);}else room.add(group);
      for(const primitive of fallback){primitive.parent?.remove(primitive);primitive.geometry?.dispose();primitive.material?.dispose();}
      if(type.bottom){const base=box((x0+x1)/2,(y0+y1)/2,width,depth,type.bottom,'#a8b1ac');if(visual){base.position.sub(new THREE.Vector3(visual.origin[0],0,-visual.origin[1]));visual.group.add(base);}}
      assetStatus.furniture[obstacle.id]=`${type.name}.gltf loaded`;render();
    }).catch(error=>{if(generation===sceneGeneration)assetStatus.furniture[obstacle.id]=`Primitive fallback: ${error.message}`;});
  }
  function makePersonAssetInstances() {
    for(const mesh of personAssetMeshes){world.remove(mesh);mesh.dispose();}
    personAssetMeshes=personAssetGeometry.map(geometry=>{
      const mesh=new THREE.InstancedMesh(geometry,personMaterial,capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.setColorAt(0,colors.walking);mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled=false;mesh.count=0;mesh.visible=!cylindersOnly;world.add(mesh);return mesh;
    });
  }
  async function loadPerson() {
    try {
      const source=await asset('person','glb');if(disposed)return;
      const bbox=new THREE.Box3().setFromObject(source),size=bbox.getSize(new THREE.Vector3());
      // The supplied T-pose is wider than it is tall; scaling its longest axis
      // would make a 1.7 m-wide person. Keep measured-footprint capsules instead.
      if(size.y/Math.max(size.x,size.z)<1.4||1.7*Math.max(size.x,size.z)/size.y>.5)throw new Error('Person asset is not a narrow standing pose; using 1.7 m capsules.');
      const scale=1.7/Math.max(size.x,size.y,size.z),center=bbox.getCenter(new THREE.Vector3()),vertex=new THREE.Vector3();
      source.traverse(object=>{
        if(!object.isMesh)return;
        const geometry=object.geometry.clone(),positions=geometry.attributes.position;
        for(let i=0;i<positions.count;i++){object.getVertexPosition(i,vertex);vertex.applyMatrix4(object.matrixWorld);positions.setXYZ(i,vertex.x,vertex.y,vertex.z);}
        geometry.deleteAttribute('skinIndex');geometry.deleteAttribute('skinWeight');geometry.morphAttributes={};
        geometry.translate(-center.x,-bbox.min.y,-center.z);geometry.scale(scale,scale,scale);geometry.computeVertexNormals();personAssetGeometry.push(geometry);
      });
      if(!personAssetGeometry.length)throw new Error('Person asset contains no drawable meshes.');
      makePersonAssetInstances();assetStatus.person='Standing person asset loaded as colored static instances.';updatePeople(lastPeople,lastTime);render();
    }catch(error){assetStatus.person=`Capsule fallback: ${error.message}`;}
  }

  function bounds(poly) {
    const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1]);
    return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
  }
  function shape(poly) {
    const result = new THREE.Shape();
    poly.forEach(([x,y],i)=>i ? result.lineTo(x,y) : result.moveTo(x,y));
    result.closePath(); return result;
  }
  function material(color, opacity=1) {
    return new THREE.MeshStandardMaterial({color,roughness:.85,transparent:opacity<1,opacity,depthWrite:opacity===1,side:THREE.DoubleSide});
  }
  function flat(poly, color, height=.015, opacity=1) {
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape(poly)), material(color,opacity));
    mesh.rotation.x = -Math.PI/2; mesh.position.y = height; room.add(mesh); return mesh;
  }
  function box(x,y,width,depth,height,color,bottom=0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),material(color));
    mesh.position.set(x,bottom+height/2,-y); room.add(mesh); return mesh;
  }
  function extrude(poly,height,color) {
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape(poly),{depth:height,bevelEnabled:false}),material(color));
    mesh.rotation.x=-Math.PI/2; room.add(mesh); return mesh;
  }
  function line(points,color,height=.035,dotted=false,closed=false) {
    const coordinates = points.map(([x,y])=>new THREE.Vector3(x,height,-y));
    if (closed&&coordinates.length) coordinates.push(coordinates[0].clone());
    const geometry = new THREE.BufferGeometry().setFromPoints(coordinates);
    const paint = dotted ? new THREE.LineDashedMaterial({color,dashSize:.09,gapSize:.17}) : new THREE.LineBasicMaterial({color});
    const result = new THREE.Line(geometry,paint);
    if (dotted) result.computeLineDistances(); room.add(result); return result;
  }
  function clearRoom() {
    const geometries = new Set(), materials = new Set();
    room.traverse(object=>{
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) for (const item of Array.isArray(object.material)?object.material:[object.material]) materials.add(item);
    });
    room.clear(); geometries.forEach(item=>item.dispose()); materials.forEach(item=>item.dispose());
    heatTexture?.dispose(); heatTexture=null; heatMesh=null;
    ownedTextures.forEach(texture=>texture.dispose());ownedTextures.clear();obstacleVisuals.clear();queueVisuals.length=0;queueTails.length=0;overflowVisuals.length=0;layoutTransition=null;
    lastHeatVersion=Symbol(); lastHeatBounds='';
  }
  function center(poly) {
    let area=0,x=0,y=0;
    for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],cross=a[0]*b[1]-b[0]*a[1];area+=cross;x+=(a[0]+b[0])*cross;y+=(a[1]+b[1])*cross;}
    if(Math.abs(area)>1e-9)return [x/(3*area),y/(3*area)];
    const [x0,y0,x1,y1]=bounds(poly);return [(x0+x1)/2,(y0+y1)/2];
  }
  function billboard(text,position,{locked=false,color='#294638',background='#ffffffdd',height=.4}={}) {
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');canvas.width=Math.min(1024,Math.max(180,text.length*14+50));canvas.height=58;
    context.fillStyle=background;context.fillRect(0,0,canvas.width,58);context.fillStyle=color;context.font='25px system-ui';context.textBaseline='middle';context.fillText(text,locked?46:14,29,canvas.width-(locked?58:28));
    if(locked){context.strokeStyle=color;context.lineWidth=4;context.beginPath();context.arc(23,24,9,Math.PI,0);context.stroke();context.fillRect(11,24,24,19);}
    const texture=new THREE.CanvasTexture(canvas);ownedTextures.add(texture);
    const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false}));
    sprite.position.set(position[0],position[2]||.2,-position[1]);sprite.scale.set(height*canvas.width/58,height,1);sprite.renderOrder=12;room.add(sprite);return sprite;
  }
  function updateLine(mesh,points,height=.06,closed=false) {
    const coordinates=points.map(([x,y])=>new THREE.Vector3(x,height,-y));if(closed&&coordinates.length)coordinates.push(coordinates[0].clone());
    const attr=mesh.geometry.attributes.position;
    if(attr&&attr.count===coordinates.length){coordinates.forEach((p,i)=>attr.setXYZ(i,p.x,p.y,p.z));attr.needsUpdate=true;mesh.geometry.computeBoundingSphere();}
    else{mesh.geometry.dispose();mesh.geometry=new THREE.BufferGeometry().setFromPoints(coordinates);}
    if(mesh.material.isLineDashedMaterial)mesh.computeLineDistances();
  }
  function queueTailPosition(polyline) {
    const tail=polyline.at(-1),previous=polyline.at(-2)||[tail[0]-1,tail[1]],length=Math.hypot(tail[0]-previous[0],tail[1]-previous[1])||1;
    return [tail[0]+(tail[0]-previous[0])/length*.85,tail[1]+(tail[1]-previous[1])/length*.85,.3];
  }
  function resample(points,count) {
    const lengths=[0];for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
    const total=lengths.at(-1),result=[];
    for(let k=0;k<count;k++){
      const d=total*k/(count-1);let i=1;while(i<lengths.length-1&&lengths[i]<d)i++;
      if(points.length===1){result.push([...points[0]]);continue;}
      const span=lengths[i]-lengths[i-1],t=span?Math.min(1,Math.max(0,(d-lengths[i-1])/span)):0;
      result.push([points[i-1][0]+(points[i][0]-points[i-1][0])*t,points[i-1][1]+(points[i][1]-points[i-1][1])*t]);
    }
    return result;
  }
  function endCameraTransition() {
    if(!cameraTransition)return;camera.position.copy(cameraTransition.to);controls.target.copy(cameraTransition.toTarget);cameraTransition=null;controls.update();
  }
  function endLayoutTransition() {
    if(!layoutTransition)return;const finished=layoutTransition;layoutTransition=null;
    for(const step of finished.moves)step(1);
    for(const highlight of finished.highlights){highlight.parent?.remove(highlight);highlight.geometry.dispose();highlight.material.dispose();}
    render();
  }
  // Presentation only: the new scene is already in place; this glides changed pieces from where they were.
  function animateLayout(previous,scene) {
    const moves=[],highlights=[];
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const glow=(mesh,opacity)=>{mesh.material.transparent=true;mesh.material.depthTest=false;mesh.material.opacity=opacity;mesh.userData.opacity=opacity;mesh.renderOrder=11;highlights.push(mesh);return mesh;};
    const reparent=(child,group)=>{child.position.sub(group.position);group.add(child);};
    const glide=(mesh,fromPoints,toPoints,height,closed)=>{
      const count=Math.max(24,fromPoints.length,toPoints.length),wrap=points=>closed?[...points,points[0]]:points;
      const a=resample(wrap(fromPoints),count),b=resample(wrap(toPoints),count);
      moves.push(f=>{if(f===1)updateLine(mesh,toPoints,height,closed);else updateLine(mesh,a.map((p,k)=>[p[0]+(b[k][0]-p[0])*f,p[1]+(b[k][1]-p[1])*f]),height,false);});
    };
    for(const obstacle of scene.obstacles){
      const before=previous.obstacles.find(o=>o.id===obstacle.id);
      if(before&&same(before.poly,obstacle.poly))continue;
      const {group,origin}=obstacleVisuals.get(obstacle.id),to=new THREE.Vector3(origin[0],0,-origin[1]);
      if(before){const start=center(before.poly),from=new THREE.Vector3(start[0],0,-start[1]);moves.push(f=>group.position.lerpVectors(from,to,f));}
      else moves.push(f=>group.scale.setScalar(.01+.99*f));
      reparent(glow(line(obstacle.poly,'#f1a832',.12,false,true),1),group);
      reparent(glow(flat(obstacle.poly,'#f1a832',.02,.35),.35),group);
    }
    scene.targets.forEach((target,i)=>{
      const before=previous.targets[i];if(!before)return;
      if(!same(before.queue_polyline,target.queue_polyline)){
        glide(queueVisuals[i],before.queue_polyline,target.queue_polyline,.04,false);
        glide(glow(line(target.queue_polyline,'#f1a832',.05),1),before.queue_polyline,target.queue_polyline,.05,false);
        const tail=queueTails[i],from=queueTailPosition(before.queue_polyline),to=queueTailPosition(target.queue_polyline);
        moves.push(f=>tail.position.set(from[0]+(to[0]-from[0])*f,.3,-(from[1]+(to[1]-from[1])*f)));
      }
      if(target.overflow_area&&before.overflow_area&&!same(before.overflow_area,target.overflow_area)){
        glide(overflowVisuals[i],before.overflow_area,target.overflow_area,.025,true);
        glide(glow(line(target.overflow_area,'#f1a832',.05,false,true),1),before.overflow_area,target.overflow_area,.05,true);
      }
      for(const [x,y] of target.service_positions)if(!before.service_positions.some(p=>same(p,[x,y])))glow(line([[x-.35,y-.35],[x+.35,y-.35],[x+.35,y+.35],[x-.35,y+.35]],'#f1a832',.06,false,true),1);
    });
    if(!moves.length&&!highlights.length)return;
    layoutTransition={started:null,moves,highlights};
    for(const step of moves)step(0);
  }
  function makeEditor() {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const context=canvas.getContext('2d');context.strokeStyle='#73917a';context.lineWidth=1;context.strokeRect(.5,.5,63,63);
    const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;ownedTextures.add(texture);
    gridMesh=flat(currentScene.walkable,'#ffffff',.008);gridMesh.material.dispose();gridMesh.material=new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:.27,depthWrite:false,side:THREE.DoubleSide});
    vertexLayer=new THREE.Group();room.add(vertexLayer);
    for(let ti=0;ti<currentScene.targets.length;ti++)for(let vi=0;vi<currentScene.targets[ti].queue_polyline.length;vi++){
      const p=currentScene.targets[ti].queue_polyline[vi],vertex=new THREE.Mesh(new THREE.SphereGeometry(.14,12,8),material('#dfaf54'));
      vertex.position.set(p[0],.2,-p[1]);vertex.userData={targetIndex:ti,vertexIndex:vi};vertexLayer.add(vertex);
    }
    hoverOutline=line([],'#75ae89',.07,false,true);selectionOutline=line([],'#f1a832',.09,false,true);
    ghost=new THREE.Group();room.add(ghost);updateEditorVisibility();
  }
  function updateEditorVisibility() {if(vertexLayer)vertexLayer.visible=mode==='plan'&&editingEnabled;if(gridMesh)gridMesh.visible=mode==='plan';}
  function makeObstacleVisual(obstacle,index) {
    const first=room.children.length;addObstacle(obstacle);const fallback=room.children.slice(first),group=new THREE.Group(),origin=center(obstacle.poly);
    group.position.set(origin[0],0,-origin[1]);group.userData.obstacleId=obstacle.id;room.add(group);
    for(const child of fallback){child.position.sub(group.position);group.add(child);}
    const type=furnitureType(obstacle),height=type?(type.bottom||0)+type.height:/fixed|column|wall/.test(obstacle.kind)?3:.9;
    const label=billboard(obstacle.id.replaceAll('_',' '),[...origin,height+.17],{locked:obstacle.locked});label.position.sub(group.position);group.add(label);
    obstacleVisuals.set(obstacle.id,{group,index,origin});decorateObstacle(obstacle,fallback,sceneGeneration);
  }
  function addWalls(scene) {
    const polygon = scene.walkable, openings = [...scene.entrances,...scene.exits];
    for (let i=0;i<polygon.length;i++) {
      const a=polygon[i], b=polygon[(i+1)%polygon.length], dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
      if(length<1e-6)continue;
      const cuts=[];
      for(const opening of openings) {
        const along=opening.poly.filter(p=>Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/length<1e-5)
          .map(p=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length).filter(t=>t>=0&&t<=length);
        if(along.length>=2)cuts.push([Math.min(...along),Math.max(...along)]);
      }
      cuts.sort((first,second)=>first[0]-second[0]);
      const spans=[];let start=0;
      for(const [lo,hi] of cuts){if(lo>start)spans.push([start,lo]);start=Math.max(start,hi);}
      if(start<length)spans.push([start,length]);
      for(const [lo,hi] of spans){
        const center=(lo+hi)/2, x=a[0]+dx*center/length,y=a[1]+dy*center/length;
        const wall=new THREE.Mesh(new THREE.BoxGeometry(hi-lo,3.8,.1),material('#acbbb1',.18));
        wall.position.set(x,1.9,-y);wall.rotation.y=Math.atan2(dy,dx);wall.renderOrder=3;room.add(wall);
        const outline=new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry),new THREE.LineBasicMaterial({color:'#9caea2',transparent:true,opacity:.4}));
        outline.position.copy(wall.position);outline.rotation.copy(wall.rotation);room.add(outline);
      }
    }
  }
  function addObstacle(obstacle) {
    const [x0,y0,x1,y1]=bounds(obstacle.poly),x=(x0+x1)/2,y=(y0+y1)/2,w=x1-x0,d=y1-y0;
    const kind=`${obstacle.kind} ${obstacle.id}`.toLowerCase();
    if(/buffet|desk|check.?in/.test(kind)) {
      extrude(obstacle.poly,.9,'#9e8261');flat(obstacle.poly,'#d3bea0',.91);
    } else if(/banquette|seating|bench/.test(kind)) {
      box(x,y,w,d,.45,'#a6b9a1');
      if(w>=d)box(x,y1-.07,w,.14,.9,'#82947f');else box(x1-.07,y,.14,d,.9,'#82947f');
    } else if(/screen/.test(kind)) {
      box(x,y,w,d,.9,'#a8b1ac');
      if(w>=d)box(x,y,w,.08,1.2,'#394943',.9);else box(x,y,.08,d,1.2,'#394943',.9);
    } else if(/round|dining|table/.test(kind)) {
      const radius=Math.min(w,d)/2;
      const top=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.07,24),material('#c4ad88'));
      top.position.set(x,.715,-y);room.add(top);
      const stem=new THREE.Mesh(new THREE.CylinderGeometry(.1,.18,.68,10),material('#8d968a'));
      stem.position.set(x,.34,-y);room.add(stem);
    } else extrude(obstacle.poly,/fixed|column|wall/.test(kind)?3:.9,obstacle.locked?'#b1b9b0':'#b9c7b4');
  }
  function regionLabel(region,color){const [x0,y0,x1,y1]=bounds(region.poly);billboard(region.id.replaceAll('_',' '),[(x0+x1)/2,y1+.45,.3],{color,height:.42});}
  function setScene(scene) {
    if(disposed)throw new Error('Watch has been disposed.');
    const firstScene=!currentScene||JSON.stringify(currentScene.walkable)!==JSON.stringify(scene.walkable),previous=currentScene;cancelEdit();currentScene=structuredClone(scene);currentBounds=bounds(scene.walkable);sceneGeneration++;clearError();clearRoom();assetStatus.furniture={};
    flat(scene.walkable,'#f6f5ee',0);
    for(const walkway of scene.walkways){flat(walkway.poly,'#c4dfb6',.01,.7);regionLabel(walkway,'#4f7e4f');}
    for(const destination of scene.destinations){line(destination.poly,'#689c80',.025,true,true);regionLabel(destination,'#477b64');}
    for(const entrance of scene.entrances){flat(entrance.poly,'#92cba8',.018);line(entrance.poly,'#40835c',.023,false,true);regionLabel(entrance,'#357650');}
    for(const exit of scene.exits){flat(exit.poly,'#adcad9',.018);line(exit.poly,'#568497',.023,false,true);regionLabel(exit,'#426d85');}
    for(const target of scene.targets){
      queueVisuals.push(line(target.queue_polyline,'#ad8540',.04,true));
      queueTails.push(billboard('Queue tail',queueTailPosition(target.queue_polyline),{color:'#967139',height:.42}));
      overflowVisuals.push(target.overflow_area?line(target.overflow_area,'#be776d',.025,true,true):null);
      const services=target.service_positions.length?target.service_positions:[target.queue_polyline[0]];
      for(const [x,y] of services)box(x,y,.3,.3,.045,'#9f83b8');
    }
    scene.obstacles.forEach(makeObstacleVisual);addWalls(scene);
    heatMesh=flat(scene.walkable,0xffffff,.03);
    heatMesh.material.dispose();
    heatMesh.material=new THREE.MeshBasicMaterial({transparent:true,opacity:1,depthWrite:false,side:THREE.DoubleSide});
    heatMesh.visible=false;
    makeEditor();if(firstScene)setPreset(preset,{animate:false});else animateLayout(previous,scene);refreshSelection();render();
  }
  function reservePeople(count) {
    if(count<=capacity)return;
    if(bodies){world.remove(bodies,heads);bodies.dispose();heads.dispose();}
    capacity=Math.max(150,2**Math.ceil(Math.log2(Math.max(1,count))));
    bodies=new THREE.InstancedMesh(bodyGeometry,personMaterial,capacity);
    heads=new THREE.InstancedMesh(headGeometry,personMaterial,capacity);
    for(const mesh of [bodies,heads]){
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.setColorAt(0,colors.walking);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.count=0;world.add(mesh);
    }
    heads.visible=!cylindersOnly;
    if(personAssetGeometry.length)makePersonAssetInstances();
  }
  function updatePeople(people,time_s=lastTime) {
    lastPeople=people;lastTime=Number.isFinite(time_s)?time_s:0;reservePeople(people.length);let index=0;
    const useAsset=personAssetMeshes.length>0&&!cylindersOnly;bodies.visible=!useAsset;heads.visible=!useAsset&&!cylindersOnly;
    for(const mesh of personAssetMeshes)mesh.visible=useAsset;
    for(const person of people){
      const p=person.position;
      if(!p||p.length!==2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||person.state==='not_arrived')continue;
      instancePeople[index]=person.id;const color=colors[person.state]||colors.walking;
      const head=(currentScene?.targets.find(t=>t.id===person.target_id)||currentScene?.targets[0])?.queue_polyline[0];
      transform.rotation.y=person.state==='queued'&&head?Math.atan2(head[0]-p[0],-(head[1]-p[1])):0;
      let phase=personPhases.get(person.id);
      if(phase===undefined){phase=0;for(const char of String(person.id))phase+=char.charCodeAt(0);personPhases.set(person.id,phase);}
      const seated=(person.state==='seated'||person.seated)&&person.placement_kind!=='standing',posture=seated?.65:1;
      const bob=person.state==='walking'?.012*(1+Math.sin(lastTime*8+phase)):0;
      transform.position.set(p[0],bob,-p[1]);transform.scale.set(1,posture,1);transform.updateMatrix();
      for(const mesh of personAssetMeshes){mesh.setMatrixAt(index,transform.matrix);mesh.setColorAt(index,color);}
      transform.position.y=bob+(cylindersOnly?.85:.675)*posture;transform.scale.set(1,(cylindersOnly?1.7/1.35:1)*posture,1);transform.updateMatrix();
      bodies.setMatrixAt(index,transform.matrix);bodies.setColorAt(index,color);
      transform.position.y=bob+1.525*posture;transform.scale.set(1,1,1);transform.updateMatrix();
      heads.setMatrixAt(index,transform.matrix);heads.setColorAt(index,color);index++;
    }
    instancePeople.length=index;for(const mesh of [bodies,heads,...personAssetMeshes]){mesh.count=index;mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;}
  }
  function update({people=[],heatCanvas=null,heatBounds=currentBounds,heatVisible=false,heatVersion=0,time_s=0}={}) {
    if(disposed)return;
    updatePeople(people,time_s);
    if(!heatMesh)return;
    heatMesh.visible=!!(heatVisible&&heatCanvas);
    if(!heatMesh.visible)return;
    const boundsKey=heatBounds.join(',');
    if(!heatTexture||heatTexture.image!==heatCanvas){
      heatTexture?.dispose();heatTexture=new THREE.CanvasTexture(heatCanvas);
      heatTexture.minFilter=THREE.NearestFilter;heatTexture.magFilter=THREE.NearestFilter;heatTexture.generateMipmaps=false;
      heatTexture.colorSpace=THREE.SRGBColorSpace;heatMesh.material.map=heatTexture;heatMesh.material.needsUpdate=true;lastHeatVersion=Symbol();
    }
    if(boundsKey!==lastHeatBounds){
      const [x0,y0,x1,y1]=heatBounds,positions=heatMesh.geometry.attributes.position,uv=heatMesh.geometry.attributes.uv;
      for(let i=0;i<uv.count;i++)uv.setXY(i,(positions.getX(i)-x0)/(x1-x0),(positions.getY(i)-y0)/(y1-y0));
      uv.needsUpdate=true;lastHeatBounds=boundsKey;
    }
    if(heatVersion!==lastHeatVersion){heatTexture.needsUpdate=true;lastHeatVersion=heatVersion;}
  }
  const errorTimers=new Map();
  const snap=value=>Math.round(value*10)/10;
  function selectedPoly(scene=currentScene){return selected?.kind==='obstacle'?scene?.obstacles.find(o=>o.id===selected.id)?.poly:null;}
  function refreshSelection(poly=selectedPoly()){if(selectionOutline)updateLine(selectionOutline,poly||[],.09,true);render();}
  function restorePreview(){
    if(!currentScene)return;
    for(const visual of obstacleVisuals.values()){visual.group.position.set(visual.origin[0],0,-visual.origin[1]);visual.group.rotation.y=0;}
    currentScene.targets.forEach((target,i)=>{if(queueVisuals[i])updateLine(queueVisuals[i],target.queue_polyline,.04);});
    for(const vertex of vertexLayer?.children||[]){const p=currentScene.targets[vertex.userData.targetIndex].queue_polyline[vertex.userData.vertexIndex];vertex.position.set(p[0],.2,-p[1]);}
    clearGhost();refreshSelection();
  }
  function cancelEdit(){
    editEpoch++;pendingEdit?.controller.abort();pendingEdit=null;drag=null;endCameraTransition();endLayoutTransition();
    controls.enabled=visible;restorePreview();renderer.domElement.style.cursor='default';
  }
  function showError(message,position){
    const point=position||center(selectedPoly()||currentScene?.walkable||[[0,0],[1,0],[1,1]]);
    const sprite=billboard(String(message),[point[0],point[1],2.5],{color:'#8c302b',background:'#fff1edee',height:.5});render();
    const timer=setTimeout(()=>{errorTimers.delete(timer);sprite.parent?.remove(sprite);ownedTextures.delete(sprite.material.map);sprite.material.map.dispose();sprite.material.dispose();render();},3000);errorTimers.set(timer,sprite);
  }
  function clearError(){for(const [timer,sprite] of errorTimers){clearTimeout(timer);sprite.parent?.remove(sprite);ownedTextures.delete(sprite.material.map);sprite.material.map.dispose();sprite.material.dispose();}errorTimers.clear();render();}
  async function submitEdit(draft,change,anchor){
    if(pendingEdit||!editingEnabled)return;
    const epoch=++editEpoch,controller=new AbortController();pendingEdit={epoch,controller};controls.enabled=false;renderer.domElement.style.cursor='progress';
    try{
      const accepted=await onEdit({scene:structuredClone(draft),change,signal:controller.signal});
      if(disposed||epoch!==editEpoch||controller.signal.aborted)return;
      pendingEdit=null;
      if(accepted&&typeof accepted==='object')setScene(accepted);
      else restorePreview();
    }catch(error){
      if(!disposed&&epoch===editEpoch&&!controller.signal.aborted){restorePreview();showError(error.message||String(error),anchor);onError(error.message||String(error));}
    }finally{if(epoch===editEpoch){pendingEdit=null;controls.enabled=visible;renderer.domElement.style.cursor='default';render();}}
  }
  function setEditingEnabled(value){const next=!!value;if(next===editingEnabled)return;editingEnabled=next;if(!next&&drag){drag=null;restorePreview();controls.enabled=visible&&!pendingEdit;}updateEditorVisibility();render();}
  function setTool(value){cancelEdit();tool=value==='select'?'move':value;renderer.domElement.style.cursor=FOOTPRINTS[tool]||tool==='keep-clear'?'crosshair':'default';render();}
  function floorPoint(event){
    const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    world.updateMatrixWorld(true);camera.updateMatrixWorld(true);raycaster.setFromCamera(pointer,camera);
    return raycaster.ray.intersectPlane(floorPlane,floorHit)?[snap(floorHit.x),snap(-floorHit.z)]:null;
  }
  function hitObstacle(){
    for(const hit of raycaster.intersectObjects([...obstacleVisuals.values()].map(v=>v.group),true)){
      let object=hit.object;while(object&&object!==room){if(object.userData.obstacleId)return currentScene.obstacles.find(o=>o.id===object.userData.obstacleId);object=object.parent;}
    }return null;
  }
  function hitPerson(){
    const meshes=[bodies,heads,...personAssetMeshes].filter(mesh=>mesh?.visible);
    const hit=raycaster.intersectObjects(meshes,false)[0];return hit?instancePeople[hit.instanceId]:undefined;
  }
  function clearGhost(){
    ghostGeneration++;ghostModel=null;ghostKind=null;if(!ghost)return;
    ghost.traverse(child=>{child.geometry?.dispose();if(child.material)for(const m of Array.isArray(child.material)?child.material:[child.material])m.dispose();});ghost.clear();
  }
  function showGhost(poly){
    if(!ghost)return;
    if(ghostKind!==tool){clearGhost();ghostKind=tool;}
    let mesh=ghost.children[0];if(!mesh){mesh=line(poly,'#55a780',.08,false,true);ghost.add(mesh);}else updateLine(mesh,poly,.08,true);
    if(FOOTPRINTS[tool]){
      const point=center(poly),[width,depth]=FOOTPRINTS[tool],type=furnitureType({kind:tool,id:tool}),height=type?(type.bottom||0)+type.height:.9;
      if(!ghostModel){
        ghostModel=new THREE.Group();ghost.add(ghostModel);
        const fallback=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),material('#75be94',.35));fallback.position.y=height/2;ghostModel.add(fallback);
        const generation=ghostGeneration,holder=ghostModel;
        if(type)asset(type.name).then(source=>{
          if(disposed||generation!==ghostGeneration)return;
          const clone=source.clone(true),normalizer=new THREE.Group();normalizer.add(clone);let bbox=new THREE.Box3().setFromObject(clone),size=bbox.getSize(new THREE.Vector3());
          if((width<depth)!==(size.x<size.z)){clone.rotation.y+=Math.PI/2;clone.updateMatrixWorld(true);bbox=new THREE.Box3().setFromObject(clone);size=bbox.getSize(new THREE.Vector3());}
          if(Math.min(size.x,size.y,size.z)<=0)return;
          const mid=bbox.getCenter(new THREE.Vector3());clone.position.sub(new THREE.Vector3(mid.x,bbox.min.y,mid.z));
          clone.traverse(object=>{if(object.isMesh){object.geometry=object.geometry.clone();const convert=m=>{const paint=m.clone();paint.transparent=true;paint.opacity=.4;paint.depthWrite=false;return paint;};object.material=Array.isArray(object.material)?object.material.map(convert):convert(object.material);}});
          normalizer.scale.set(width/size.x,height/size.y,depth/size.z);holder.remove(fallback);fallback.geometry.dispose();fallback.material.dispose();holder.add(normalizer);render();
        }).catch(()=>{/* The visible primitive remains the placement preview. */});
      }
      ghostModel.position.set(point[0],0,-point[1]);
    }
    render();
  }
  function rectangle(a,b){return [[Math.min(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[1])],[Math.min(a[0],b[0]),Math.max(a[1],b[1])]];}
  function footprint(point){const [w,h]=FOOTPRINTS[tool];return rectangle([snap(point[0]-w/2),snap(point[1]-h/2)],[snap(point[0]+w/2),snap(point[1]+h/2)]);}
  function stopPointer(event){event.preventDefault();event.stopImmediatePropagation();}
  function pointerDown(event){
    if(event.button!==0||!currentScene)return;
    const point=floorPoint(event);if(!point)return;
    renderer.domElement.focus({preventScroll:true});
    if(pendingEdit){stopPointer(event);return;}
    if(!editingEnabled){const id=hitPerson();if(id!==undefined){stopPointer(event);onSelectPerson(id);}return;}
    const vertex=vertexLayer?.visible?raycaster.intersectObjects(vertexLayer.children,false)[0]?.object:null;
    const obstacle=hitObstacle(),person=hitPerson();
    if(person!==undefined&&!vertex&&!obstacle&&!FOOTPRINTS[tool]&&tool!=='keep-clear'){stopPointer(event);onSelectPerson(person);return;}
    if(FOOTPRINTS[tool])drag={kind:'place',start:point,point,draft:structuredClone(currentScene)};
    else if(tool==='keep-clear')drag={kind:'walkway',start:point,point,draft:structuredClone(currentScene)};
    else if(vertex){const {targetIndex,vertexIndex}=vertex.userData;selected={kind:'queue',targetIndex,vertexIndex};drag={...selected,start:point,draft:structuredClone(currentScene)};}
    else if(obstacle){
      selected={kind:'obstacle',id:obstacle.id,index:currentScene.obstacles.indexOf(obstacle)};refreshSelection();
      if(tool==='lock'){
        stopPointer(event);const draft=structuredClone(currentScene);draft.obstacles[selected.index].locked=!obstacle.locked;
        void submitEdit(draft,{kind:'lock',id:obstacle.id,index:selected.index},center(obstacle.poly));return;
      }
      if(obstacle.locked){stopPointer(event);showError('Locked — use the lock tool to unlock.',center(obstacle.poly));return;}
      drag={...selected,start:point,point,draft:structuredClone(currentScene),original:obstacle.poly.map(p=>[...p]),origin:center(obstacle.poly),angle:0};
    }else{selected=null;refreshSelection();return;}
    stopPointer(event);endCameraTransition();endLayoutTransition();controls.enabled=false;renderer.domElement.setPointerCapture(event.pointerId);renderer.domElement.style.cursor='grabbing';
  }
  function previewObstacle(){
    const dx=snap(drag.point[0]-drag.start[0]),dy=snap(drag.point[1]-drag.start[1]),cos=Math.round(Math.cos(drag.angle)),sin=Math.round(Math.sin(drag.angle)),[cx,cy]=drag.origin;
    const poly=drag.original.map(([x,y])=>[snap(cx+(x-cx)*cos-(y-cy)*sin+dx),snap(cy+(x-cx)*sin+(y-cy)*cos+dy)]);
    drag.draft.obstacles[drag.index].poly=poly;const visual=obstacleVisuals.get(drag.id);visual.group.position.set(cx+dx,0,-cy-dy);visual.group.rotation.y=drag.angle;refreshSelection(poly);
  }
  function pointerMove(event){
    if(!currentScene||pendingEdit)return;const point=floorPoint(event);if(!point)return;
    if(drag){
      stopPointer(event);drag.point=point;drag.moved=drag.moved||Math.hypot(point[0]-drag.start[0],point[1]-drag.start[1])>.05;
      if(drag.kind==='obstacle')previewObstacle();
      else if(drag.kind==='queue'){
        const target=drag.draft.targets[drag.targetIndex];target.queue_polyline[drag.vertexIndex]=point;
        updateLine(queueVisuals[drag.targetIndex],target.queue_polyline,.04);
        const vertex=vertexLayer.children.find(v=>v.userData.targetIndex===drag.targetIndex&&v.userData.vertexIndex===drag.vertexIndex);vertex.position.set(point[0],.2,-point[1]);
      }else showGhost(drag.kind==='place'?footprint(point):rectangle(drag.start,point));render();return;
    }
    if(!editingEnabled)return;
    if(FOOTPRINTS[tool]){showGhost(footprint(point));return;}
    const obstacle=hitObstacle();updateLine(hoverOutline,obstacle?.poly||[],.07,true);renderer.domElement.style.cursor=obstacle?(obstacle.locked?'not-allowed':'grab'):tool==='keep-clear'?'crosshair':'default';render();
  }
  function pointerUp(event){
    if(!drag)return;stopPointer(event);const finished=drag;drag=null;
    if(renderer.domElement.hasPointerCapture(event.pointerId))renderer.domElement.releasePointerCapture(event.pointerId);
    controls.enabled=visible;renderer.domElement.style.cursor='default';
    const point=finished.point||finished.start;
    if(finished.kind==='place'){
      let index=1,id;do{id=`${tool}_${index++}`;}while(currentScene.obstacles.some(o=>o.id===id));
      finished.draft.obstacles.push({id,kind:tool,locked:false,poly:footprint(point)});selected={kind:'obstacle',id,index:finished.draft.obstacles.length-1};
      void submitEdit(finished.draft,{kind:'add',id,index:selected.index},point);
    }else if(finished.kind==='walkway'){
      if(!finished.moved||Math.abs(point[0]-finished.start[0])<.1||Math.abs(point[1]-finished.start[1])<.1){restorePreview();return;}
      let index=1,id;do{id=`keep_clear_${index++}`;}while(currentScene.walkways.some(w=>w.id===id));
      finished.draft.walkways.push({id,poly:rectangle(finished.start,point)});void submitEdit(finished.draft,{kind:'walkway',id},point);
    }else if(finished.moved||finished.angle){
      const change=finished.kind==='queue'?{kind:'queue',target_id:currentScene.targets[finished.targetIndex].id,index:finished.targetIndex,vertexIndex:finished.vertexIndex}:{kind:'move',id:finished.id,index:finished.index};
      void submitEdit(finished.draft,change,point);
    }else restorePreview();
  }
  function keyDown(event){
    if(event.key==='Escape'){stopPointer(event);cancelEdit();return;}
    if(!editingEnabled||pendingEdit||!selected||!['r','R','Delete','Backspace'].includes(event.key))return;
    stopPointer(event);const obstacle=currentScene.obstacles.find(o=>o.id===selected.id);if(!obstacle)return;
    if(obstacle.locked){showError('Locked objects cannot be moved or deleted.',center(obstacle.poly));return;}
    if(event.key.toLowerCase()==='r'&&drag?.kind==='obstacle'){drag.angle+=Math.PI/2;drag.moved=true;previewObstacle();return;}
    const draft=structuredClone(currentScene),index=draft.obstacles.findIndex(o=>o.id===obstacle.id),anchor=center(obstacle.poly);
    if(event.key.toLowerCase()==='r'){
      const [cx,cy]=anchor;draft.obstacles[index].poly=obstacle.poly.map(([x,y])=>[snap(cx-(y-cy)),snap(cy+(x-cx))]);
      const visual=obstacleVisuals.get(obstacle.id);visual.group.rotation.y=Math.PI/2;refreshSelection(draft.obstacles[index].poly);
      void submitEdit(draft,{kind:'rotate',id:obstacle.id,index},anchor);
    }else{
      draft.obstacles.splice(index,1);draft.layout_options=(draft.layout_options||[]).filter(option=>option.obstacle_id!==obstacle.id);
      void submitEdit(draft,{kind:'delete',id:obstacle.id,index},anchor);
    }
  }
  function pointerCancel(){cancelEdit();}
  renderer.domElement.addEventListener('pointerdown',pointerDown,true);
  renderer.domElement.addEventListener('pointermove',pointerMove,true);
  renderer.domElement.addEventListener('pointerup',pointerUp,true);
  renderer.domElement.addEventListener('pointercancel',pointerCancel,true);
  renderer.domElement.addEventListener('keydown',keyDown);

  function configureCamera(nextMode) {
    mode=nextMode;camera=mode==='plan'?planCamera:perspectiveCamera;controls.object=camera;
    controls.enableRotate=mode==='room';controls.maxPolarAngle=mode==='plan'?Math.PI/2:Math.PI/2-.025;
    controls.mouseButtons.LEFT=mode==='plan'?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;
    updateEditorVisibility();resize(viewWidth,viewHeight);
  }
  function setPreset(name,{animate=true}={}) {
    if(!['plan','door','buffet','overhead'].includes(name))throw new Error(`Unknown Watch camera preset: ${name}`);
    const oldPosition=camera.position.clone(),oldTarget=controls.target.clone();preset=name;configureCamera(name==='plan'?'plan':'room');
    const [x0,y0,x1,y1]=currentBounds,cx=(x0+x1)/2,cy=(y0+y1)/2,span=Math.max(x1-x0,y1-y0),position=new THREE.Vector3(),target=new THREE.Vector3(cx,0,-cy);
    controls.maxDistance=span*3;camera.far=Math.max(100,span*8);camera.updateProjectionMatrix();
    const entry=currentScene?.entrances[0],door=entry?center(entry.poly):[cx,y1];
    const served=currentScene?.targets.find(t=>/buffet/i.test(t.id))||currentScene?.targets[0],desk=served?center(served.poly):[x1,cy];
    if(name==='door'){
      // From the end of the room opposite the service point, on the entrance side, so door, queue and desks all fit.
      let ux=desk[0]-cx,uy=desk[1]-cy,u=Math.hypot(ux,uy)||1;ux/=u;uy/=u;
      const side=Math.sign((door[0]-cx)*-uy+(door[1]-cy)*ux)||1,aside=Math.min(x1-x0,y1-y0)*.4*side,back=span*.38;
      position.set(cx-ux*back-uy*aside,6,-(cy-uy*back+ux*aside));target.set(cx+ux*span*.22,.3,-(cy+uy*span*.22));
    }else if(name==='buffet'){
      const b=served?bounds(served.poly):[x1,cy,x1,cy];
      position.set(x1+1.3,2.8,-(b[1]+b[3])/2);target.set(x0+(x1-x0)*.4,.85,-(b[1]+b[3])/2);
    }else position.set(cx,span*(name==='plan'?2:1.12),-cy+(name==='plan'?.0001:span*.13));
    cameraTransition=animate?{from:oldPosition,to:position,fromTarget:oldTarget,toTarget:target,started:performance.now()}:null;
    camera.position.copy(animate?oldPosition:position);controls.target.copy(animate?oldTarget:target);controls.update();render();
  }
  function setMode(value){setPreset(value==='plan'?'plan':'overhead');}
  function resize(width,height) {
    viewWidth=Math.max(1,width);viewHeight=Math.max(1,height);const aspect=viewWidth/viewHeight;
    renderer.setSize(viewWidth,viewHeight,false);perspectiveCamera.aspect=aspect;perspectiveCamera.updateProjectionMatrix();
    const [x0,y0,x1,y1]=currentBounds,half=Math.max((y1-y0)/2,(x1-x0)/2/aspect)*1.12;
    planCamera.left=-half*aspect;planCamera.right=half*aspect;planCamera.top=half;planCamera.bottom=-half;planCamera.updateProjectionMatrix();render();
  }
  function setVisible(value) {visible=!!value;host.hidden=!visible;controls.enabled=visible&&!drag&&!pendingEdit;if(visible)render();}
  function capturePlan(){
    if(!currentScene)throw new Error('Load a room before capturing its plan.');
    endLayoutTransition();
    const saved={camera,mode,preset,position:camera.position.clone(),target:controls.target.clone(),transition:cameraTransition,zoom:planCamera.zoom,heat:heatMesh?.visible};
    const hidden=[bodies,heads,...personAssetMeshes,vertexLayer,ghost,hoverOutline,selectionOutline].filter(Boolean).map(mesh=>[mesh,mesh.visible]);
    try{setPreset('plan',{animate:false});planCamera.zoom=1;planCamera.updateProjectionMatrix();hidden.forEach(([mesh])=>mesh.visible=false);if(heatMesh)heatMesh.visible=false;
      renderer.render(world,camera);return renderer.domElement.toDataURL('image/png');
    }finally{hidden.forEach(([mesh,value])=>mesh.visible=value);camera=saved.camera;mode=saved.mode;preset=saved.preset;controls.object=camera;camera.position.copy(saved.position);controls.target.copy(saved.target);planCamera.zoom=saved.zoom;planCamera.updateProjectionMatrix();cameraTransition=saved.transition;if(heatMesh)heatMesh.visible=saved.heat;controls.enableRotate=mode==='room';controls.mouseButtons.LEFT=mode==='plan'?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;updateEditorVisibility();controls.update();render();}
  }
  function useCylinders() {cylindersOnly=true;if(heads)heads.visible=false;updatePeople(lastPeople);render();}
  function dispose() {
    if(disposed)return;cancelEdit();disposed=true;cancelAnimationFrame(renderRequest);clearError();
    for(const [name,handler] of [['pointerdown',pointerDown],['pointermove',pointerMove],['pointerup',pointerUp],['pointercancel',pointerCancel]])renderer.domElement.removeEventListener(name,handler,true);
    renderer.domElement.removeEventListener('keydown',keyDown);controls.removeEventListener('change',render);controls.dispose();clearRoom();
    bodies?.dispose();heads?.dispose();personAssetMeshes.forEach(mesh=>mesh.dispose());personAssetGeometry.forEach(geometry=>geometry.dispose());
    bodyGeometry.dispose();headGeometry.dispose();personMaterial.dispose();assetSources.forEach(releaseSource);assetSources.clear();
    renderer.dispose();renderer.domElement.remove();
  }
  reservePeople(150);
  resize(host.clientWidth||800,host.clientHeight||500);
  void loadPerson();
  return {setScene,resize,update,render,setPreset,setMode,setTool,setEditingEnabled,setVisible,dispose,useCylinders,showError,clearError,capturePlan,
    getDebugState:()=>({mode,preset,tool,editingEnabled,dragging:!!drag,pending:!!pendingEdit,selected:structuredClone(selected),scene:structuredClone(currentScene),renderCalls,instanceCount:instancePeople.length}),
    projectPoint:([x,y],height=0)=>{const p=new THREE.Vector3(x,height,-y).project(camera),rect=renderer.domElement.getBoundingClientRect();return [rect.left+(p.x+1)*rect.width/2,rect.top+(1-p.y)*rect.height/2];},
    getAssetStatus:()=>structuredClone(assetStatus)};
}
