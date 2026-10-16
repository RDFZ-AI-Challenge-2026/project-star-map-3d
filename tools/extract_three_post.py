import tarfile, os
p = os.path.join("data","raw","three-0.186.1.tgz")
want = ("postprocessing/", "shaders/CopyShader", "shaders/LuminosityHighPassShader", "shaders/OutputShader")
with tarfile.open(p,"r:gz") as t:
    names = []
    for n in t.getnames():
        if not n.startswith("package/examples/jsm/"): continue
        rel = n[len("package/examples/jsm/"):]
        if any(rel.startswith(w) for w in want) and n.endswith(".js"):
            names.append(n)
    for n in sorted(names):
        print(round(t.getmember(n).size/1024,1), "KB", n)
    dest = os.path.join("data","raw","extracted","three-0.186.1")
    t.extractall(dest, members=[t.getmember(n) for n in names], filter="data")
print("extracted", len(names), "files")
