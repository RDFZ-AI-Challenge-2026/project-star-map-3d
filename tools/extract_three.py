import tarfile, os
p = os.path.join("data","raw","three-0.186.1.tgz")
with tarfile.open(p,"r:gz") as t:
    names = [n for n in t.getnames() if n.startswith("package/build/") or "controls/OrbitControls" in n or n.endswith("package/package.json")]
    for n in sorted(names):
        m = t.getmember(n)
        print(round(m.size/1024,1), "KB", n)
    dest = os.path.join("data","raw","extracted","three-0.186.1")
    os.makedirs(dest, exist_ok=True)
    t.extractall(dest, members=[t.getmember(n) for n in names], filter="data")
print("extracted to", dest)
