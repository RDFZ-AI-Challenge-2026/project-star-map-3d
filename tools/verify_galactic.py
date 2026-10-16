import numpy as np
# equatorial J2000 (x -> RA 0h, z -> NCP) to galactic
R = np.array([
 [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
 [ 0.4941094278755837, -0.4448296299600112,  0.7469822444972189],
 [-0.8676661490190047, -0.1980763734312015,  0.4559837761750669]])
def eq(ra_h, dec_deg):
    ra = np.radians(ra_h*15.0); dec = np.radians(dec_deg)
    return np.array([np.cos(dec)*np.cos(ra), np.cos(dec)*np.sin(ra), np.sin(dec)])
g = R @ eq(12+51/60+26.28/3600, 27.12825)
print("galactic north pole ->", np.round(g,6), "(expect 0,0,1)")
gc = R @ eq(17+45/60+37.2/3600, -28.93617)
print("galactic centre     ->", np.round(gc,6), "(expect 1,0,0)")
print("R determinant:", round(float(np.linalg.det(R)),6), "(expect 1)")
