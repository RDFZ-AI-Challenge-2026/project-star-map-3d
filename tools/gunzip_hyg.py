import gzip, os
src = os.path.join("data","raw","hygdata_v40.csv.gz")
dst = os.path.join("data","raw","hygdata_v40.csv")
with gzip.open(src, "rb") as f:
    data = f.read()
print("decompressed bytes:", len(data), "=", round(len(data)/1048576,2), "MB")
print("header:", data[:300].decode("utf-8","replace").split("\n")[0][:200])
print("newlines:", data.count(b"\n"))
print("ends with newline:", data.endswith(b"\n"))
print("last line:", data.strip().split(b"\n")[-1][:120].decode("utf-8","replace"))
with open(dst, "wb") as f: f.write(data)
print("wrote", dst)
