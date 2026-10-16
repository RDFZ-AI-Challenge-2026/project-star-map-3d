import tarfile, os, sys
raw = sys.argv[1]
out = sys.argv[2]
for f in ["three-starmap-0.0.5.tgz","d3-celestial-0.7.35.tgz"]:
    p = os.path.join(raw,f)
    dest = os.path.join(out, f.replace(".tgz",""))
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(p,"r:gz") as t:
        t.extractall(dest)
    print("==== ", f)
    for root,dirs,files in os.walk(dest):
        for fn in files:
            fp=os.path.join(root,fn)
            print("   ", round(os.path.getsize(fp)/1024,1), "KB", os.path.relpath(fp,dest))
