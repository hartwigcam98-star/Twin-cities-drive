# Mixamo FBX animations (on the Ty rig) -> clips on the Boss skeleton, in Golf Go's R3 clip format
import sys, json, base64, math
sys.path.insert(0, '/home/claude/hartwigcam98-star/golf-go/pipeline/chars')
import numpy as np
from conv import Scene, names, sample
L = sys.argv[1]; OUT = sys.argv[2]
boss = json.load(open(sys.argv[3]))
bn = boss['names']; par = boss['parent']; nb = len(bn)
inv = np.frombuffer(base64.b64decode(boss['inv']), dtype='<f4')
def rotof(M):
    R = M[:3, :3].copy()
    for c in range(3): R[:, c] /= np.linalg.norm(R[:, c])
    return R
RB = [rotof(np.linalg.inv(inv[k*16:(k+1)*16].reshape(4, 4).astype(float))) for k in range(nb)]
PB = [np.linalg.inv(inv[k*16:(k+1)*16].reshape(4, 4).astype(float))[:3, 3] for k in range(nb)]
# source bind pose: the skin clusters of Ty.fbx
ty = Scene(f'{L}/Ty.fbx'); tn = names(ty)
bind = {}
for oid, o in ty.obj.items():
    if o.name == 'Deformer' and 'Cluster' in str(o.props[2] if len(o.props) > 2 else ''):
        tl = o.find('TransformLink')
        if tl is None: continue
        M = np.array(tl.props[0], float).reshape(4, 4).T
        for ch, ps in ty.parent.items():
            if oid in ps and ch in ty.models: bind.setdefault(tn[ch], M)
print('bind bones', len(bind))
def quat(R):
    t = np.trace(R)
    if t > 0: s = math.sqrt(t + 1) * 2; return [(R[2,1]-R[1,2])/s, (R[0,2]-R[2,0])/s, (R[1,0]-R[0,1])/s, 0.25*s]
    if R[0,0] > R[1,1] and R[0,0] > R[2,2]: s = math.sqrt(1+R[0,0]-R[1,1]-R[2,2])*2; return [0.25*s, (R[0,1]+R[1,0])/s, (R[0,2]+R[2,0])/s, (R[2,1]-R[1,2])/s]
    if R[1,1] > R[2,2]: s = math.sqrt(1+R[1,1]-R[0,0]-R[2,2])*2; return [(R[0,1]+R[1,0])/s, 0.25*s, (R[1,2]+R[2,1])/s, (R[0,2]-R[2,0])/s]
    s = math.sqrt(1+R[2,2]-R[0,0]-R[1,1])*2; return [(R[0,2]+R[2,0])/s, (R[1,2]+R[2,1])/s, 0.25*s, (R[1,0]-R[0,1])/s]
hipB = PB[bn.index('Hips')][1]; hipT = bind['Hips'][1, 3]; sc = hipB / hipT
print('hip boss', hipB, 'ty', hipT, 'scale', sc)
CLIPS = {'walk': 'walking.fbx', 'run': 'running.fbx', 'jump': 'jump.fbx', 'idle': 'idle.fbx', 'turnL': 'left turn.fbx', 'turnR': 'right turn.fbx',
         'strafeL': 'left strafe walking.fbx', 'strafeR': 'right strafe walking.fbx'}
out = {}
for key, fn in CLIPS.items():
    a = Scene(f'{L}/{fn}'); an = names(a); tr = a.anim()
    dur = max(cv[0].max() for d in tr.values() for c in d.values() for cv in c.values())
    fps = 30; n = int(round(dur * fps)) + 1
    byname = {an[i]: i for i in a.models}
    Q = np.zeros((n, nb, 4)); H = np.zeros((n, 3))
    for f in range(n):
        W = sample(a, tr, f / fps)
        WB = [None] * nb
        for j in range(nb):
            name = bn[j]
            if name in byname and name in bind:
                WT = rotof(W[byname[name]]); RT = rotof(bind[name])
                WB[j] = WT @ RT.T @ RB[j]
            else:
                p = par[j]; WB[j] = (WB[p] @ RB[p].T @ RB[j]) if p >= 0 else RB[j]
            p = par[j]; Lr = (WB[p].T @ WB[j]) if p >= 0 else WB[j]
            q = quat(Lr); 
            if f > 0 and np.dot(q, Q[f-1, j]) < 0: q = [-x for x in q]
            Q[f, j] = q
        H[f] = W[byname['Hips']][:3, 3] * sc
    if key == 'jump': H[:, 1] = H[0, 1] # the game moves the body; keep the pose, not the height
    qi = np.round(np.clip(Q, -1, 1) * 32767).astype('<i2')
    out[key] = {'fps': fps, 't0': 0, 'n': n, 'anim': list(range(nb)), 'q': base64.b64encode(qi.tobytes()).decode(), 'qs': base64.b64encode(qi[0].tobytes()).decode(), 'hip': base64.b64encode(H.astype('<f4').tobytes()).decode()}
    print(key, n, 'hip start', np.round(H[0], 1), 'end', np.round(H[-1], 1))
open(OUT, 'w').write('R3ANIMS(' + json.dumps(out, separators=(',', ':')) + ');\n')
