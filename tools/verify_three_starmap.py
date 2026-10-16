import json, os, math, statistics
p = os.path.join("data","raw","extracted","three-starmap-0.0.5","package","data","visibleStarsFormatted.json")
d = json.load(open(p, encoding="utf-8"))
rs = [math.sqrt(s["x"]**2+s["y"]**2+s["z"]**2) for s in d]
print("three-starmap stars:", len(d))
print("radius min/median/max:", round(min(rs),4), round(statistics.median(rs),4), round(max(rs),4))
print("=> all stars sit on ONE sphere of radius ~", round(statistics.median(rs),3), "-> direction only, no real distance")
print("keys per entry:", sorted(d[0].keys()))
