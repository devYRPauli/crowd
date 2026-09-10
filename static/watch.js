// Presentation only: all coordinates and states come from the existing 2D playback.
// Three.js r180 is pinned; no model, simulation, frame fetch, or private animation clock.
const THREE_URL = 'https://esm.sh/three@0.180.0';
const ORBIT_URL = 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';
const GLTF_URL = 'https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
const STATE_COLORS = {walking:'#4479b4',queued:'#cf9d31',in_service:'#8a60ae',overflow:'#d25242',done:'#3e926d'};

export async function createWatch(host) {
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor('#edf1eb');
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of the same measured rehearsal');
  host.appendChild(renderer.domElement);
  const world = new THREE.Scene(), room = new THREE.Group();
  world.add(room);
  world.add(new THREE.AmbientLight(0xffffff, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(-8, 22, -12); world.add(sun);
  const camera = new THREE.PerspectiveCamera(48, 1, .05, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 1.5;
  controls.maxPolarAngle = Math.PI / 2 - .025;
  controls.screenSpacePanning = false;
  let visible = false, disposed = false, currentScene = null, currentBounds = [0,0,24,14];
  let preset = 'overhead', capacity = 0, bodies, heads, cylindersOnly = false;
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
  function render() { if (visible && !disposed) renderer.render(world, camera); }
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
      group.position.set((x0+x1)/2,type.bottom||0,-(y0+y1)/2);room.add(group);
      for(const primitive of fallback){room.remove(primitive);primitive.geometry?.dispose();primitive.material?.dispose();}
      if(type.bottom)box((x0+x1)/2,(y0+y1)/2,width,depth,type.bottom,'#a8b1ac');
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
    if (closed) coordinates.push(coordinates[0].clone());
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
    lastHeatVersion=Symbol(); lastHeatBounds='';
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
  function setScene(scene) {
    if(disposed)throw new Error('Watch has been disposed.');
    currentScene=scene;currentBounds=bounds(scene.walkable);sceneGeneration++;clearRoom();assetStatus.furniture={};
    flat(scene.walkable,'#f6f5ee',0);
    for(const walkway of scene.walkways)flat(walkway.poly,'#c4dfb6',.01,.7);
    for(const destination of scene.destinations)line(destination.poly,'#689c80',.025,true,true);
    for(const entrance of scene.entrances){flat(entrance.poly,'#92cba8',.018);line(entrance.poly,'#40835c',.023,false,true);}
    for(const exit of scene.exits){flat(exit.poly,'#adcad9',.018);line(exit.poly,'#568497',.023,false,true);}
    for(const target of scene.targets){
      line(target.queue_polyline,'#ad8540',.04,true);
      if(target.overflow_area)line(target.overflow_area,'#be776d',.025,true,true);
      const services=target.service_positions.length?target.service_positions:[target.queue_polyline[0]];
      for(const [x,y] of services)box(x,y,.3,.3,.045,'#9f83b8');
    }
    for(const obstacle of scene.obstacles){const first=room.children.length;addObstacle(obstacle);decorateObstacle(obstacle,room.children.slice(first),sceneGeneration);}addWalls(scene);
    heatMesh=flat(scene.walkable,0xffffff,.03);
    heatMesh.material.dispose();
    heatMesh.material=new THREE.MeshBasicMaterial({transparent:true,opacity:1,depthWrite:false,side:THREE.DoubleSide});
    heatMesh.visible=false;
    setPreset(preset);render();
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
      const color=colors[person.state]||colors.walking;
      let phase=personPhases.get(person.id);
      if(phase===undefined){phase=0;for(const char of String(person.id))phase+=char.charCodeAt(0);personPhases.set(person.id,phase);}
      const bob=person.state==='walking'?.012*(1+Math.sin(lastTime*8+phase)):0;
      transform.position.set(p[0],bob,-p[1]);transform.scale.set(1,1,1);transform.updateMatrix();
      for(const mesh of personAssetMeshes){mesh.setMatrixAt(index,transform.matrix);mesh.setColorAt(index,color);}
      transform.position.y=bob+(cylindersOnly?.85:.675);transform.scale.set(1,cylindersOnly?1.7/1.35:1,1);transform.updateMatrix();
      bodies.setMatrixAt(index,transform.matrix);bodies.setColorAt(index,color);
      transform.position.y=bob+1.525;transform.scale.set(1,1,1);transform.updateMatrix();
      heads.setMatrixAt(index,transform.matrix);heads.setColorAt(index,color);index++;
    }
    for(const mesh of [bodies,heads,...personAssetMeshes]){mesh.count=index;mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;}
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
  function setPreset(name) {
    if(!['door','buffet','overhead'].includes(name))throw new Error(`Unknown Watch camera preset: ${name}`);
    preset=name;const [x0,y0,x1,y1]=currentBounds,cx=(x0+x1)/2,cy=(y0+y1)/2,span=Math.max(x1-x0,y1-y0);
    controls.maxDistance=span*3;camera.far=Math.max(100,span*8);camera.updateProjectionMatrix();
    if(name==='door'){
      const entries=currentScene?.entrances||[];
      const north=entries.reduce((best,item)=>!best||bounds(item.poly)[3]>bounds(best.poly)[3]?item:best,null);
      const e=north?bounds(north.poly):[cx,y1,cx,y1];
      camera.position.set((e[0]+e[2])/2,2.1,-Math.max(e[1],e[3])-.7);controls.target.set(cx,1,-(y0+(y1-y0)*.35));
    }else if(name==='buffet'){
      const target=currentScene?.targets.find(t=>/buffet/i.test(t.id))||currentScene?.targets[0];
      const b=target?bounds(target.poly):[x1,cy,x1,cy];
      camera.position.set(x1+1.3,2.8,-(b[1]+b[3])/2);controls.target.set(x0+(x1-x0)*.4,.85,-(b[1]+b[3])/2);
    }else{camera.position.set(cx,span*1.12,-cy+span*.13);controls.target.set(cx,0,-cy);}
    controls.update();render();
  }
  function resize(width,height) {
    width=Math.max(1,width);height=Math.max(1,height);
    renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();render();
  }
  function setVisible(value) {visible=!!value;host.hidden=!visible;controls.enabled=visible;if(visible)render();}
  function useCylinders() {cylindersOnly=true;if(heads)heads.visible=false;updatePeople(lastPeople);render();}
  function dispose() {
    if(disposed)return;disposed=true;controls.removeEventListener('change',render);controls.dispose();clearRoom();
    bodies?.dispose();heads?.dispose();personAssetMeshes.forEach(mesh=>mesh.dispose());personAssetGeometry.forEach(geometry=>geometry.dispose());
    bodyGeometry.dispose();headGeometry.dispose();personMaterial.dispose();assetSources.forEach(releaseSource);assetSources.clear();
    renderer.dispose();renderer.domElement.remove();
  }
  reservePeople(150);
  resize(host.clientWidth||800,host.clientHeight||500);
  void loadPerson();
  return {setScene,resize,update,render,setPreset,setVisible,dispose,useCylinders,getAssetStatus:()=>structuredClone(assetStatus)};
}
