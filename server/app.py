import io
import os
import re
import json
import math
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import List, Dict, Tuple, Optional, Any

from flask import Flask, jsonify, request, send_from_directory, send_file, abort, after_this_request, render_template

try:
    from .auth import init_auth
except ImportError:  # Container entrypoint imports app.py as a top-level module.
    from auth import init_auth


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_ROOT = Path(os.environ.get("DATA_ROOT", str(BASE_DIR.parent))).resolve()
DEFAULT_LATTICE_DIR = (DEFAULT_DATA_ROOT / "Lattice").resolve()
DEFAULT_MR_DIR = (DEFAULT_DATA_ROOT / "MR").resolve()
DEFAULT_FERMI_ROOT_DIR = (DEFAULT_DATA_ROOT / "fermi_surface").resolve()
DEFAULT_FERMI_DIR = (DEFAULT_DATA_ROOT / "soc_fermi_surface").resolve()
DEFAULT_FERMI_NOSOC_DIR = (DEFAULT_DATA_ROOT / "wosoc_fermi_surface").resolve()
DEFAULT_DOWNLOAD_DIR = (DEFAULT_DATA_ROOT / "download").resolve()
DEFAULT_MP_META_CSV = (DEFAULT_DATA_ROOT / "MR" / "Materials_for_Wannier_Function_Construction.csv").resolve()
DEFAULT_BAND_DIR = (DEFAULT_DATA_ROOT / "Band").resolve()


def normalize_base_url(value: str) -> str:
    """Normalize an externally visible URL prefix such as /plausible."""
    text = (value or "").strip()
    if not text or text == "/":
        return ""
    if "://" in text or "?" in text or "#" in text:
        raise ValueError("BASE_URL must be a path prefix, for example /plausible")
    return "/" + text.strip("/")

# Temporarily excluded from public display while their transport data is reviewed.
TEMPORARILY_HIDDEN_MATERIAL_IDS = frozenset({
    "NbN_SG187",
    "Sr5Sb3_SG193",
    "TaSe2_SG164",
    "TaSe2_SG166",
    "Tl_SG194",
    "BaGe_SG63",
    "HfGeSe_SG129",
    "NbAs_SG109",
    "SrAgAs_SG194",
    "Ta3AlC2_SG194",
    "TaN_SG189",
})

ATOMIC_SYMBOLS = [
    "H", "He",
    "Li", "Be", "B", "C", "N", "O", "F", "Ne",
    "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar",
    "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Ga", "Ge", "As", "Se", "Br", "Kr",
    "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "In", "Sn", "Sb", "Te", "I", "Xe",
    "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy",
    "Ho", "Er", "Tm", "Yb", "Lu",
    "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn",
    "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf",
    "Es", "Fm", "Md", "No", "Lr",
    "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
    "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
]
ATOMIC_NUMBER_BY_SYMBOL = {s: i + 1 for i, s in enumerate(ATOMIC_SYMBOLS)}


def parse_formula_string(formula: str) -> Dict[str, int]:
    """Parse a chemical formula string into a composition dict.

    Supports:
      - element symbols with integer counts: "BaGa2H2"
      - parentheses/brackets with multipliers: "Ba(GaH)2", "Fe2(SO4)3"
      - dot-separated additives (hydrates): "CuSO4·5H2O" (treated as sum)

    Returns a dict {element: count}. Raises ValueError on malformed formulas.
    """
    text = (formula or "").strip()
    if not text:
        return {}
    # normalize brackets and separators
    text = text.replace("[", "(").replace("]", ")").replace("{", "(").replace("}", ")")
    text = text.replace("·", ".")
    text = re.sub(r"\s+", "", text)
    # allow common separators for element-mode input, e.g. "Ag,F"
    text = text.replace(",", "")

    def merge(dst: Dict[str, int], src: Dict[str, int], mul: int = 1) -> None:
        for k, v in src.items():
            if v:
                dst[k] = dst.get(k, 0) + v * mul

    def parse_part(part: str) -> Dict[str, int]:
        s = part

        def parse_int(i: int) -> Tuple[int, int]:
            j = i
            while j < len(s) and s[j].isdigit():
                j += 1
            if j == i:
                return 1, i
            return int(s[i:j]), j

        def parse_group(i: int, stop: Optional[str] = None) -> Tuple[Dict[str, int], int]:
            comp: Dict[str, int] = {}
            while i < len(s):
                ch = s[i]
                if stop and ch == stop:
                    break
                if ch == "(":
                    sub, i = parse_group(i + 1, ")")
                    if i >= len(s) or s[i] != ")":
                        raise ValueError("unmatched '(' in formula")
                    i += 1
                    mul, i = parse_int(i)
                    merge(comp, sub, mul)
                    continue
                if ch.isupper():
                    el = ch
                    i += 1
                    if i < len(s) and s[i].islower():
                        el += s[i]
                        i += 1
                    mul, i = parse_int(i)
                    comp[el] = comp.get(el, 0) + mul
                    continue
                if ch.isdigit():
                    # leading coefficient for the next term (e.g., 2H2O)
                    coef, i = parse_int(i)
                    if i >= len(s):
                        raise ValueError("dangling coefficient in formula")
                    if s[i] == "(":
                        sub, i = parse_group(i + 1, ")")
                        if i >= len(s) or s[i] != ")":
                            raise ValueError("unmatched '(' in formula")
                        i += 1
                        mul, i = parse_int(i)
                        merge(comp, sub, coef * mul)
                        continue
                    if s[i].isupper():
                        el = s[i]
                        i += 1
                        if i < len(s) and s[i].islower():
                            el += s[i]
                            i += 1
                        mul, i = parse_int(i)
                        comp[el] = comp.get(el, 0) + coef * mul
                        continue
                    raise ValueError("invalid coefficient placement in formula")
                raise ValueError(f"invalid character '{ch}' in formula")
            return comp, i

        comp_part, j = parse_group(0, None)
        if j != len(s):
            raise ValueError("trailing characters in formula")
        return comp_part

    total: Dict[str, int] = {}
    for part in filter(None, text.split(".")):
        merge(total, parse_part(part), 1)

    total = {k: v for k, v in total.items() if v}
    if not total:
        raise ValueError("empty/invalid formula")
    return total


def canonical_formula(comp: Dict[str, int]) -> str:
    """Return a canonical formula string (alphabetical, omit 1)."""
    parts = []
    for el in sorted(comp.keys()):
        c = comp[el]
        parts.append(f"{el}{'' if c == 1 else c}")
    return "".join(parts) if parts else ""


def reduce_composition(comp: Dict[str, int]) -> Dict[str, int]:
    """Reduce composition to the smallest whole-number ratio."""
    from math import gcd
    if not comp:
        return {}
    values = list(comp.values())
    g = 0
    for v in values:
        g = gcd(g, v)
    if g <= 1:
        return dict(comp)
    return {k: v // g for k, v in comp.items()}


def parse_mp_id_number(mpid: Optional[str]) -> Optional[int]:
    """Extract numeric part from MP ID, e.g. mp-153 -> 153."""
    s = (mpid or "").strip()
    if not s:
        return None
    m = re.search(r"mp-(\d+)", s, flags=re.IGNORECASE)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


# --------------- BXSF (Fermi surface) parsing utilities ---------------
def parse_bxsf_meta(path: Path) -> Dict:
    """Lightweight parser to extract meta info from FS3D.bxsf without loading grids."""
    fermi = 0.0
    num_bands = None
    dims: Tuple[int, int, int] = (0, 0, 0)
    origin: List[float] = []
    vectors: List[List[float]] = []

    with path.open("r", encoding="utf-8", errors="ignore") as f:
        # grab fermi energy if present near the top
        for ln in f:
            if "Fermi Energy" in ln:
                try:
                    m = re.search(r"Fermi Energy:\s*([\-0-9\.Ee\+]+)", ln)
                    if m:
                        fermi = float(m.group(1))
                except Exception:
                    pass
            if ln.strip().startswith("BEGIN_BLOCK_BANDGRID_3D"):
                break
        # find the bandgrid block (e.g., BEGIN_BANDGRID_3D_fermi)
        section_line = None
        for ln in f:
            if ln.strip().startswith("BEGIN_BANDGRID_3D"):
                section_line = ln
                break
        # some files have a comment line (e.g., from_wannier_code) before the real begin line
        if section_line and not section_line.strip().startswith("BEGIN_BANDGRID_3D_"):
            for ln in f:
                if ln.strip().startswith("BEGIN_BANDGRID_3D_"):
                    section_line = ln
                    break
        if not section_line:
            raise ValueError("BXSF missing BEGIN_BANDGRID_3D section")

        try:
            num_bands = int(next(f).split()[0])
            a, b, c = next(f).split()
            dims = (int(a), int(b), int(c))
            origin = [float(x) for x in next(f).split()[:3]]
            for _ in range(3):
                vec_tokens = next(f).split()
                vectors.append([float(x) for x in vec_tokens[:3]])
        except StopIteration as e:
            raise ValueError("Unexpected end of BXSF header") from e
        except Exception as e:
            raise ValueError(f"Failed to parse BXSF header: {e}") from e

    total_points = dims[0] * dims[1] * dims[2]
    return {
        "fermi_energy": fermi,
        "num_bands": num_bands,
        "dims": dims,
        "origin": origin,
        "vectors": vectors,
        "total_points": total_points,
    }


def load_bxsf_band(path: Path, band_idx: int, total_points: int) -> List[float]:
    """Read a single band grid from BXSF. band_idx is 1-based."""
    if band_idx < 1:
        raise ValueError("Band index must be >= 1")
    pattern = re.compile(r"BAND:\s*([0-9]+)")
    values: List[float] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        while True:
            header = f.readline()
            if not header:
                break
            m = pattern.search(header)
            if not m:
                continue
            idx = int(m.group(1))
            if idx != band_idx:
                # Skip values for this band
                remaining = total_points
                while remaining > 0:
                    ln = f.readline()
                    if not ln:
                        break
                    remaining -= len(ln.split())
                continue

            # Target band
            while len(values) < total_points:
                ln = f.readline()
                if not ln:
                    break
                if ln.strip().startswith("BAND"):
                    # encountered next band before collecting all values
                    break
                for tok in ln.split():
                    try:
                        values.append(float(tok))
                    except Exception:
                        pass
            break

    if not values:
        raise ValueError(f"Band {band_idx} not found in BXSF")
    if len(values) < total_points:
        raise ValueError(f"Band {band_idx} truncated: {len(values)} / {total_points}")
    # truncate in case of extra tokens so caller gets exact size
    return values[:total_points]


def compute_bxsf_band_ranges(path: Path) -> List[Dict]:
    """Single-pass scan of FS3D.bxsf to get min/max per band without storing full grids."""
    pattern = re.compile(r"BAND:\s*([0-9]+)")
    bands: List[Dict] = []
    current_idx: Optional[int] = None
    count = 0
    vmin = float("inf")
    vmax = float("-inf")

    with path.open("r", encoding="utf-8", errors="ignore") as f:
        # Skip header until the first BAND line
        for ln in f:
            if ln.strip().startswith("BAND"):
                break
        else:
            return bands

        # Process from the first BAND line onward
        while True:
            if ln.strip().startswith("BAND"):
                # flush previous
                if current_idx is not None:
                    bands.append({"band": current_idx, "min": vmin, "max": vmax, "count": count})
                m = pattern.search(ln)
                current_idx = int(m.group(1)) if m else None
                count = 0
                vmin = float("inf")
                vmax = float("-inf")
                ln = f.readline()
                if not ln:
                    break
                continue
            if current_idx is None:
                ln = f.readline()
                if not ln:
                    break
                continue
            for tok in ln.split():
                try:
                    v = float(tok)
                except Exception:
                    continue
                count += 1
                if v < vmin:
                    vmin = v
                if v > vmax:
                    vmax = v
            ln = f.readline()
            if not ln:
                break

        if current_idx is not None:
            bands.append({"band": current_idx, "min": vmin, "max": vmax, "count": count})

    return bands


def parse_poscar(path: Path) -> Dict:
    """Parse a VASP POSCAR/BPOSCAR file into a dict with lattice and atomic sites.

    Supports VASP5+ style with element symbols line, and older style (best-effort).
    """
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        lines = [ln.strip() for ln in f if ln.strip() != ""]

    if len(lines) < 8:
        raise ValueError("POSCAR appears too short")

    title = lines[0]
    scale = float(lines[1].split()[0])
    a = list(map(float, lines[2].split()))
    b = list(map(float, lines[3].split()))
    c = list(map(float, lines[4].split()))

    # Try VASP5: element symbols + counts
    # If the 6th line contains non-numeric tokens, treat as symbols line
    symbols_line = lines[5]
    is_symbols = any(not tok.replace('.', '', 1).isdigit() for tok in symbols_line.split())

    idx = 5
    elements: List[str] = []
    counts: List[int] = []

    if is_symbols:
        elements = symbols_line.split()
        idx += 1
        counts = list(map(int, lines[idx].split()))
        idx += 1
    else:
        # VASP4 style, counts at line 6; try to infer elements from title or fallback
        counts = list(map(int, symbols_line.split()))
        idx += 1
        # Infer elements from title by capital letters, else from filename
        inferred = re.findall(r"[A-Z][a-z]?", title)
        if len(inferred) == len(counts):
            elements = inferred
        else:
            # fallback to generic E1, E2 ... (will be replaced by folder parsing later in index)
            elements = [f"E{i+1}" for i in range(len(counts))]

    # Optional Selective dynamics line
    if lines[idx].lower().startswith("selective"):
        idx += 1

    # Coordinate system line
    coord_line = lines[idx].lower()
    if not (coord_line.startswith("direct") or coord_line.startswith("cart")):
        raise ValueError("Expected 'Direct' or 'Cartesian' line in POSCAR")
    is_direct = coord_line.startswith("direct")
    idx += 1

    natoms = sum(counts)
    coords: List[Tuple[float, float, float]] = []
    # Read natoms lines of coordinates; ignore trailing flags if present
    for i in range(natoms):
        parts = lines[idx + i].split()
        x, y, z = map(float, parts[:3])
        coords.append((x, y, z))

    # Build species per atom
    species: List[str] = []
    for el, n in zip(elements, counts):
        species.extend([el] * n)

    data = {
        "title": title,
        "scale": scale,
        "lattice": {
            "a": a,
            "b": b,
            "c": c,
        },
        "coordinate_type": "Direct" if is_direct else "Cartesian",
        "atoms": [
            {"element": sp, "position": list(coords[i])}
            for i, sp in enumerate(species)
        ],
    }
    return data


def composition_from_poscar(poscar_data: Dict) -> Dict[str, int]:
    comp: Dict[str, int] = {}
    for atom in poscar_data.get("atoms", []):
        el = atom.get("element", "")
        if el:
            comp[el] = comp.get(el, 0) + 1
    return comp


def extract_sg_from_folder(name: str) -> Optional[int]:
    m = re.search(r"_SG(\d+)", name)
    return int(m.group(1)) if m else None


def normalize_space_group_token(val: object) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    if not s:
        return ""
    m = re.search(r"\d+", s)
    return m.group(0) if m else s


def infer_elements_from_folder(name: str) -> Dict[str, int]:
    # Folder name like 'AlAu_SG11' -> take part before first underscore
    base = name.split("_")[0]
    return parse_formula_string(base)


def load_materials_index(lattice_dir: Path) -> List[Dict]:
    materials: List[Dict] = []
    for entry in sorted(lattice_dir.iterdir()):
        if not entry.is_dir():
            continue
        mat_id = entry.name
        if mat_id in TEMPORARILY_HIDDEN_MATERIAL_IDS:
            continue
        bposcar_path = entry / "BPOSCAR"
        poscar_path = entry / "POSCAR"
        pposcar_path = entry / "PPOSCAR"
        has_bposcar = bposcar_path.exists()
        has_poscar = poscar_path.exists()
        has_pposcar = pposcar_path.exists()

        # Prefer parsing composition from POSCAR-like files if present; otherwise infer from folder.
        comp: Dict[str, int] = {}
        try:
            if has_pposcar:
                src = pposcar_path
            elif has_poscar:
                src = poscar_path
            elif has_bposcar:
                src = bposcar_path
            else:
                src = None
            if src is not None:
                pdata = parse_poscar(src)
                comp = composition_from_poscar(pdata)
            else:
                comp = infer_elements_from_folder(mat_id)
        except Exception:
            try:
                comp = infer_elements_from_folder(mat_id)
            except Exception:
                comp = {}

        reduced = reduce_composition(comp)
        materials.append({
            "id": mat_id,
            "path": str(entry),
            "has_poscar": has_poscar or has_pposcar,
            "has_pposcar": has_pposcar,
            "has_bposcar": has_bposcar,
            "space_group": extract_sg_from_folder(mat_id),
            "composition": comp,
            "reduced_composition": reduced,
            "formula": canonical_formula(comp),
            "reduced_formula": canonical_formula(reduced),
        })
    return materials


def create_app(test_config: Optional[Dict[str, Any]] = None) -> Flask:
    app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")
    app.config["BASE_URL"] = normalize_base_url(os.environ.get("BASE_URL", ""))
    init_auth(app, test_config)

    def request_base_url() -> str:
        forwarded_prefix = (request.headers.get("X-Forwarded-Prefix") or "").split(",", 1)[0]
        return normalize_base_url(forwarded_prefix) if forwarded_prefix.strip() else app.config["BASE_URL"]

    def render_app_html(filename: str):
        path = Path(app.static_folder) / filename
        if not path.exists():
            abort(404)
        content = path.read_text(encoding="utf-8")
        content = content.replace("__APP_BASE_URL_JSON__", json.dumps(request_base_url()))
        auth_bar = render_template("auth/_account_bar.html") if app.config["AUTH_ENABLED"] else ""
        content = content.replace("__AUTH_ACCOUNT_BAR__", auth_bar)
        return app.response_class(content, mimetype="text/html")

    lattice_dir = Path(os.environ.get("LATTICE_DIR", str(DEFAULT_LATTICE_DIR))).resolve()
    app.config["LATTICE_DIR"] = str(lattice_dir)
    # MR data root
    mr_dir = Path(os.environ.get("MR_DIR", str(DEFAULT_MR_DIR))).resolve()
    app.config["MR_DIR"] = str(mr_dir)

    # Build materials index from lattice directory
    materials_index = load_materials_index(lattice_dir)
    app.config["MATERIALS_INDEX"] = materials_index
    app.config["MATERIAL_BY_ID"] = {m.get("id"): m for m in materials_index if m.get("id")}
    # Precompute element co-occurrence map for highlighting
    element_neighbors: Dict[str, set] = defaultdict(set)
    for rec in materials_index:
        comp = rec.get("reduced_composition") or {}
        els = list(comp.keys())
        for ei in els:
            for ej in els:
                if ej == ei:
                    continue
                element_neighbors[ei].add(ej)
    app.config["ELEMENT_NEIGHBORS"] = {k: sorted(v) for k, v in element_neighbors.items()}
    # Optional MP/ICSD metadata (prefer exact Formula+SG match, fallback to unique formula)
    mp_meta_csv = Path(os.environ.get("MP_META_CSV", str(DEFAULT_MP_META_CSV))).resolve()
    mp_meta_by_formula_sg: Dict[Tuple[str, str], Dict[str, str]] = {}
    mp_meta_grouped: Dict[str, Dict[str, Dict[str, str]]] = defaultdict(dict)
    if mp_meta_csv.exists():
        import csv

        try:
            with mp_meta_csv.open("r", encoding="utf-8", errors="ignore") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    raw_formula = (row.get("Formula") or row.get("formula") or "").strip()
                    if not raw_formula:
                        continue
                    # 归一化成与 reduced_formula 相同的形式，避免 MgAg/AgMg 不一致
                    try:
                        comp = parse_formula_string(raw_formula)
                        comp_red = reduce_composition(comp)
                        formula_key = canonical_formula(comp_red)
                    except Exception:
                        formula_key = raw_formula
                    if not formula_key:
                        continue
                    sg_raw = (row.get("Space Group") or row.get("SpaceGroup") or row.get("SG") or "").strip()
                    sg_key = normalize_space_group_token(sg_raw)
                    mpid = (row.get("Materials ID") or row.get("MaterialsID") or row.get("MP ID") or "").strip()
                    icsd = (row.get("Latest ICSD") or row.get("ICSD") or "").strip()
                    # Keep original CSV formula for display (e.g., Ba(GaH)2)
                    meta = {"mp_id": mpid, "icsd": icsd, "formula": raw_formula}
                    if sg_key:
                        mp_meta_by_formula_sg[(formula_key, sg_key)] = meta
                    mp_meta_grouped[formula_key][sg_key] = meta
        except Exception:
            mp_meta_by_formula_sg = {}
            mp_meta_grouped = defaultdict(dict)

    mp_meta_by_formula_single: Dict[str, Dict[str, str]] = {}
    for formula_key, metas_by_sg in mp_meta_grouped.items():
        if len(metas_by_sg) == 1:
            mp_meta_by_formula_single[formula_key] = next(iter(metas_by_sg.values()))

    app.config["MP_META_BY_FORMULA_SG"] = mp_meta_by_formula_sg
    app.config["MP_META_BY_FORMULA_SINGLE"] = mp_meta_by_formula_single
    # Fermi surface roots. New layout is:
    #   fermi_surface/<material>/{soc,wosoc}/FS3D.bxsf
    # Keep the legacy roots as a fallback while deployments migrate data.
    fermi_root_dir = Path(
        os.environ.get(
            "FERMI_ROOT_DIR",
            os.environ.get("FERMI_SURFACE_DIR", str(DEFAULT_FERMI_ROOT_DIR)),
        )
    ).resolve()
    app.config["FERMI_ROOT_DIR"] = str(fermi_root_dir)
    fermi_dir = Path(os.environ.get("FERMI_DIR", str(DEFAULT_FERMI_DIR))).resolve()
    app.config["FERMI_DIR"] = str(fermi_dir)
    fermi_nosoc_dir = Path(os.environ.get("FERMI_NOSOC_DIR", str(DEFAULT_FERMI_NOSOC_DIR))).resolve()
    app.config["FERMI_NOSOC_DIR"] = str(fermi_nosoc_dir)
    download_dir = Path(os.environ.get("DOWNLOAD_DIR", str(DEFAULT_DOWNLOAD_DIR))).resolve()
    app.config["DOWNLOAD_DIR"] = str(download_dir)
    band_dir = Path(os.environ.get("BAND_DIR", str(DEFAULT_BAND_DIR))).resolve()
    app.config["BAND_DIR"] = str(band_dir)

    @app.route("/")
    def index_page():
        return render_app_html("index.html")

    @app.route("/m/<mat_id>")
    def material_page(mat_id: str):
        # Serve the material detail page; the JS will read mat_id from the URL
        if mat_id in TEMPORARILY_HIDDEN_MATERIAL_IDS:
            abort(404)
        return render_app_html("material.html")

    @app.route("/static/fermi_render_temp.html")
    def fermi_render_temp_page():
        resp = render_app_html("fermi_render_temp.html")
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.route("/api/health")
    def health():
        return jsonify({
            "status": "ok",
            "base_url": app.config["BASE_URL"],
            "lattice_dir": app.config["LATTICE_DIR"],
            "count": len(app.config["MATERIALS_INDEX"]),
        })

    @app.route("/api/element_neighbors/<el>")
    def element_neighbors_api(el: str):
        neighbors = app.config.get("ELEMENT_NEIGHBORS", {})
        vals = neighbors.get(el, [])
        return jsonify({"element": el, "neighbors": vals, "count": len(vals)})

    @app.route("/api/element_candidates")
    def element_candidates():
        els_param = (request.args.get("elements") or "").strip()
        mode = (request.args.get("mode", "at_least_elements") or "at_least_elements").lower()
        tokens = [e for e in re.split(r"[,\-\s]+", els_param) if e]
        selected = set(tokens)
        if not selected:
            return jsonify({"elements": [], "total": 0})

        idx: List[Dict] = app.config["MATERIALS_INDEX"]
        allowed: set = set(selected)
        total_matches = 0
        for rec in idx:
            comp = rec.get("reduced_composition") or {}
            rec_els = set(comp.keys())
            # 对高亮逻辑，only_elements 与 at_least_elements 一致：包含已选元素即可
            if selected.issubset(rec_els):
                allowed |= rec_els
                total_matches += 1

        return jsonify({"elements": sorted(allowed), "total": total_matches})

    @app.route("/api/search")
    def search():
        q = request.args.get("q", "").strip()
        mode = (request.args.get("mode", "formula") or "formula").lower()
        sort_mode = (request.args.get("sort", "composition") or "composition").lower()
        page = max(1, request.args.get("page", default=1, type=int) or 1)
        per_page_param = request.args.get("per_page", default=None, type=int)
        per_page_default = 15 if not q else 200
        per_page = per_page_param if per_page_param and per_page_param > 0 else per_page_default
        per_page = min(per_page, 500)
        idx: List[Dict] = app.config["MATERIALS_INDEX"]

        # Parse query
        q_elements: set = set()
        try:
            q_comp = parse_formula_string(q)
            q_comp_red = reduce_composition(q_comp)
            q_can = canonical_formula(q_comp_red)
            q_elements = set(q_comp_red.keys()) if isinstance(q_comp_red, dict) else set()
        except Exception:
            q_comp = {}
            q_comp_red = {}
            q_can = q
        # fallback: simple token extraction (supports B-Cr or B,Cr)
        if (mode in ("only_elements", "at_least_elements")) and (not q_elements) and q:
            q_elements = set(e for e in re.findall(r"[A-Z][a-z]?", q))

        results: List[Dict] = []
        # element set for element-based modes
        if isinstance(q_comp_red, dict) and q_comp_red:
            q_elements = set(q_comp_red.keys())

        for rec in idx:
            rec_comp_red = rec.get("reduced_composition") or {}
            rec_elements = set(rec_comp_red.keys())

            if mode == "only_elements":
                # 只由这些元素构成（不关心配比）
                if not q_elements and not q:
                    results.append(rec.copy())
                elif q_elements and rec_elements == q_elements:
                    results.append(rec.copy())
                continue
            if mode == "at_least_elements":
                # 至少包含这些元素（可以还有其它元素）
                if not q_elements and not q:
                    results.append(rec.copy())
                elif q_elements and q_elements.issubset(rec_elements):
                    results.append(rec.copy())
                continue

            # 默认: 按配方匹配 + 模糊搜索
            if q_comp_red and rec_comp_red == q_comp_red:
                results.append(rec.copy())
                continue
            if not q:
                results.append(rec.copy())
            elif (
                q.lower() in rec["id"].lower()
                or q.lower() in rec.get("formula", "").lower()
                or q.lower() in rec.get("reduced_formula", "").lower()
                or q.lower() in str(rec.get("space_group"))
            ):
                results.append(rec.copy())

        # Attach MP / ICSD info (if available) by (formula, space group)
        mp_meta_by_formula_sg: Dict[Tuple[str, str], Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SG", {})  # type: ignore
        mp_meta_by_formula_single: Dict[str, Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SINGLE", {})  # type: ignore
        for rec in results:
            formula_key = (rec.get("reduced_formula") or rec.get("formula") or "").strip()
            sg_key = normalize_space_group_token(rec.get("space_group"))
            meta = mp_meta_by_formula_sg.get((formula_key, sg_key)) if formula_key and sg_key else None
            if not meta and formula_key:
                meta = mp_meta_by_formula_single.get(formula_key)
            if meta:
                rec["mp_id"] = meta.get("mp_id")
                rec["icsd"] = meta.get("icsd")
                # Prefer CSV formula formatting for display when available
                if meta.get("formula"):
                    rec["display_formula"] = meta.get("formula")

        # Sort exact matches first, then by composition complexity by default:
        # total atoms in reduced formula ascending (1, 2, 3, ...).
        # For elemental materials, use atomic number order.
        # Important: sort before pagination so ordering is global and stable.
        def sort_key(rec):
            formula_key = (rec.get("reduced_formula") or rec.get("formula") or "").strip()
            display_formula = (rec.get("display_formula") or formula_key or "").strip()
            sg_key = normalize_space_group_token(rec.get("space_group"))
            mp_num = parse_mp_id_number(rec.get("mp_id"))
            mp_missing = 1 if mp_num is None else 0
            mp_rank = mp_num if mp_num is not None else 10**12
            try:
                sg_num = int(sg_key) if sg_key else 10**9
            except Exception:
                sg_num = 10**9

            rec_comp_red = rec.get("reduced_composition") or {}
            if not rec_comp_red and formula_key:
                try:
                    c = parse_formula_string(formula_key)
                    rec_comp_red = reduce_composition(c)
                except Exception:
                    rec_comp_red = {}
            try:
                atom_total = int(sum(int(v) for v in rec_comp_red.values())) if rec_comp_red else 10**9
            except Exception:
                atom_total = 10**9
            species_count = len(rec_comp_red) if rec_comp_red else 10**9
            if species_count == 1 and atom_total == 1:
                el = next(iter(rec_comp_red.keys()))
                atomic_num = ATOMIC_NUMBER_BY_SYMBOL.get(el, 10**6)
            else:
                atomic_num = 10**6

            if sort_mode == "formula":
                return (
                    formula_key != q_can,
                    display_formula.lower(),
                    sg_num,
                    mp_missing,
                    mp_rank,
                    rec.get("id", ""),
                )
            if sort_mode == "mp":
                return (
                    formula_key != q_can,
                    mp_missing,
                    mp_rank,
                    display_formula.lower(),
                    sg_num,
                    rec.get("id", ""),
                )
            # default: composition-first ordering
            return (
                formula_key != q_can,
                atom_total,
                species_count,
                atomic_num,
                display_formula.lower(),
                sg_num,
                rec.get("id", ""),
            )

        results.sort(key=sort_key)

        total = len(results)
        start = (page - 1) * per_page
        end = start + per_page
        results_page = results[start:end] if start < total else []

        return jsonify({
            "results": results_page,
            "query": q,
            "canonical": q_can,
            "mode": mode,
            "total": total,
            "page": page,
            "per_page": per_page,
        })

    @app.route("/api/materials/<mat_id>")
    def material_detail(mat_id: str):
        if mat_id in TEMPORARILY_HIDDEN_MATERIAL_IDS:
            return jsonify({"error": "Not found"}), 404
        lattice_dir = Path(app.config["LATTICE_DIR"])  # type: ignore
        entry = lattice_dir / mat_id
        meta = next((m for m in app.config["MATERIALS_INDEX"] if m["id"] == mat_id), None)
        if not meta:
            # fallback build minimal
            meta = {
                "id": mat_id,
                "space_group": extract_sg_from_folder(mat_id),
            }
        # Attach MP / ICSD and CSV-formula for display (if available)
        mp_meta_by_formula_sg: Dict[Tuple[str, str], Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SG", {})  # type: ignore
        mp_meta_by_formula_single: Dict[str, Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SINGLE", {})  # type: ignore
        formula_key = (meta.get("reduced_formula") or meta.get("formula") or "").strip()
        sg_key = normalize_space_group_token(meta.get("space_group"))
        m = mp_meta_by_formula_sg.get((formula_key, sg_key)) if formula_key and sg_key else None
        if not m and formula_key:
            m = mp_meta_by_formula_single.get(formula_key)
        if m:
            meta["mp_id"] = m.get("mp_id")
            meta["icsd"] = m.get("icsd")
            if m.get("formula"):
                meta["display_formula"] = m.get("formula")

        if not entry.exists():
            return jsonify({"error": "Not found"}), 404

        # NOTE:
        # - Primitive cell display should prefer PPOSCAR when available.
        # - Conventional cell display uses BPOSCAR.
        out = {"meta": meta, "poscar": None, "bposcar": None}

        pposcar_path = entry / "PPOSCAR"
        poscar_path = entry / "POSCAR"
        bposcar_path = entry / "BPOSCAR"
        # Prefer PPOSCAR for primitive cell rendering
        poscar_src = pposcar_path if pposcar_path.exists() else poscar_path
        if poscar_src.exists():
            try:
                out["poscar"] = parse_poscar(poscar_src)
                out["poscar_source"] = poscar_src.name
            except Exception as e:
                out["poscar_error"] = str(e)
        if bposcar_path.exists():
            try:
                out["bposcar"] = parse_poscar(bposcar_path)
            except Exception as e:
                out["bposcar_error"] = str(e)

        return jsonify(out)

    @app.route("/api/materials/<mat_id>/poscar")
    def download_material_poscar(mat_id: str):
        lattice_dir = Path(app.config["LATTICE_DIR"])  # type: ignore
        entry = lattice_dir / mat_id
        if not entry.exists():
            return jsonify({"error": "Not found"}), 404

        cell_type = (request.args.get("type") or "primitive").lower()
        if cell_type == "conventional":
            path = entry / "BPOSCAR"
            if not path.exists():
                return jsonify({"error": "BPOSCAR not found"}), 404
        else:
            path = entry / "PPOSCAR"
            if not path.exists():
                path = entry / "POSCAR"
            if not path.exists():
                return jsonify({"error": "PPOSCAR/POSCAR not found"}), 404

        return send_file(
            path,
            as_attachment=True,
            download_name=f"{mat_id}_{path.name}",
            mimetype="text/plain",
        )

    # ------------------------- Fermi surface APIs -------------------------
    def _material_download_dir(mat_id: str) -> Optional[Path]:
        if not mat_id or "/" in mat_id or "\\" in mat_id or mat_id in {".", ".."}:
            return None
        root = Path(app.config["DOWNLOAD_DIR"]).resolve()  # type: ignore
        path = (root / mat_id).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        return path if path.exists() and path.is_dir() else None

    def _wannier_download_files(mat_id: str, variant: str) -> List[Path]:
        base = _material_download_dir(mat_id)
        if not base:
            return []
        variant_dir = base / variant
        if not variant_dir.exists() or not variant_dir.is_dir():
            return []
        files: List[Path] = []
        seen = set()
        for pattern in ("*.win", "*.wout", "*hr.dat"):
            for p in sorted(variant_dir.glob(pattern)):
                if not p.is_file() or p in seen:
                    continue
                seen.add(p)
                files.append(p)
        return files

    def _bundle_arcname(mat_id: str, variant: str, filename: str) -> str:
        safe_name = Path(filename).name
        return f"{mat_id}/{variant}/{safe_name}"

    def _fermi_file_for(mat_id: str, variant: str = "soc") -> Optional[Path]:
        variant_norm = "nosoc" if (variant or "soc") == "nosoc" else "soc"
        root = Path(app.config["FERMI_ROOT_DIR"])  # type: ignore
        variant_dirs = ("soc",) if variant_norm == "soc" else ("wosoc", "nosoc")
        for variant_dir in variant_dirs:
            p = root / mat_id / variant_dir / "FS3D.bxsf"
            if p.exists():
                return p

        key = "FERMI_DIR" if variant_norm == "soc" else "FERMI_NOSOC_DIR"
        legacy_root = Path(app.config[key])  # type: ignore
        p = legacy_root / mat_id / "FS3D.bxsf"
        return p if p.exists() else None

    @app.route("/api/materials/<mat_id>/wannier-fermi.zip")
    def download_wannier_fermi_bundle(mat_id: str):
        entries: List[Tuple[Path, str]] = []
        for variant in ("soc", "wosoc"):
            entries.extend(
                (p, _bundle_arcname(mat_id, variant, p.name))
                for p in _wannier_download_files(mat_id, variant)
            )
            fermi_variant = "soc" if variant == "soc" else "nosoc"
            fermi_path = _fermi_file_for(mat_id, fermi_variant)
            if fermi_path:
                entries.append((fermi_path, _bundle_arcname(mat_id, variant, "FS3D.bxsf")))

        if not entries:
            return jsonify({"error": "download bundle files not found"}), 404

        tmp_dir_value = (os.environ.get("TMP_DIR") or "").strip()
        tmp_dir = Path(tmp_dir_value).resolve() if tmp_dir_value else None
        tmp = tempfile.NamedTemporaryFile(
            prefix=f"{mat_id}_",
            suffix=".zip",
            dir=str(tmp_dir) if tmp_dir else None,
            delete=False,
        )
        tmp_path = Path(tmp.name)
        tmp.close()
        try:
            with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                for src, arcname in entries:
                    zf.write(src, arcname)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            raise

        @after_this_request
        def _cleanup_temp_zip(response):
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            return response

        return send_file(
            tmp_path,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{mat_id}_wannier_fermi.zip",
            max_age=0,
        )

    def _request_fermi_variant(default: str = "soc") -> str:
        raw = (
            request.args.get("dataset")
            or request.args.get("variant")
            or default
            or "soc"
        )
        token = str(raw).strip().lower().replace("-", "").replace("_", "")
        return "nosoc" if token in {"nosoc", "withoutsoc", "wosoc"} else "soc"

    @app.route("/api/fermi/<mat_id>")
    def fermi_meta(mat_id: str):
        variant = _request_fermi_variant("soc")
        p = _fermi_file_for(mat_id, variant)
        if not p:
            msg = "未找到无 SOC 费米面文件 FS3D.bxsf" if variant == "nosoc" else "未找到费米面文件 FS3D.bxsf"
            return jsonify({"available": False, "message": msg, "variant": variant})
        try:
            meta = parse_bxsf_meta(p)
            bands = compute_bxsf_band_ranges(p)
        except Exception as e:
            return jsonify({"available": False, "error": str(e), "variant": variant})
        fermi = meta.get("fermi_energy") or 0.0
        bands_info = []
        for b in bands:
            mn = b.get("min")
            mx = b.get("max")
            has = False
            if mn is not None and mx is not None:
                has = (fermi >= mn - 1e-8) and (fermi <= mx + 1e-8)
            bands_info.append({
                "band": b.get("band"),
                "min": mn,
                "max": mx,
                "count": b.get("count"),
                "has_fermi": has,
            })
        return jsonify({
            "available": True,
            "variant": variant,
            "num_bands": meta.get("num_bands"),
            "dims": list(meta.get("dims", [])),
            "fermi_energy": meta.get("fermi_energy"),
            "origin": meta.get("origin"),
            "vectors": meta.get("vectors"),
            "bands": bands_info,
        })

    @app.route("/api/fermi/<mat_id>/band/<int:band_idx>")
    def fermi_band(mat_id: str, band_idx: int):
        variant = _request_fermi_variant("soc")
        p = _fermi_file_for(mat_id, variant)
        if not p:
            msg = "未找到无 SOC 的 FS3D.bxsf 文件" if variant == "nosoc" else "未找到 FS3D.bxsf 文件"
            return jsonify({"error": msg, "variant": variant}), 404
        try:
            meta = parse_bxsf_meta(p)
        except Exception as e:
            return jsonify({"error": str(e), "variant": variant}), 500
        num_bands = meta.get("num_bands") or 0
        if band_idx < 1 or band_idx > num_bands:
            return jsonify({
                "error": f"能带索引超出范围 1..{num_bands}",
                "num_bands": num_bands,
                "variant": variant,
            }), 400

        total = meta["total_points"]
        try:
            values = load_bxsf_band(p, band_idx, total)
        except Exception as e:
            return jsonify({"error": str(e), "variant": variant}), 500
        vmin = min(values) if values else None
        vmax = max(values) if values else None
        return jsonify({
            "band": band_idx,
            "variant": variant,
            "dims": list(meta.get("dims", [])),
            "fermi_energy": meta.get("fermi_energy"),
            "origin": meta.get("origin"),
            "vectors": meta.get("vectors"),
            "values": values,
            "min": vmin,
            "max": vmax,
        })

    @app.route("/api/fermi/<mat_id>/frmsf")
    def fermi_frmsf(mat_id: str):
        """Return FermiSurfer .frmsf content converted from BXSF."""
        variant = _request_fermi_variant("soc")
        p = _fermi_file_for(mat_id, variant)
        if not p:
            msg = "未找到无 SOC 的 FS3D.bxsf 文件" if variant == "nosoc" else "未找到 FS3D.bxsf 文件"
            return jsonify({"error": msg, "variant": variant}), 404
        try:
            meta = parse_bxsf_meta(p)
        except Exception as e:
            return jsonify({"error": f"解析 FS3D 失败: {e}", "variant": variant}), 500

        dims = meta.get("dims") or (0, 0, 0)
        num_bands = meta.get("num_bands") or 0
        if not all(dims) or num_bands <= 0:
            return jsonify({"error": "BXSF 头信息缺失"}), 500

        # Decide which bands to include
        bands_param = (request.args.get("bands") or "").strip()
        bands_selected = []
        if bands_param:
            try:
                bands_selected = [
                    b for b in (
                        int(x) for x in re.split(r"[,\s]+", bands_param) if x.strip()
                    )
                    if 1 <= b <= num_bands
                ]
            except Exception:
                bands_selected = []
        if not bands_selected:
            try:
                ranges = compute_bxsf_band_ranges(p)
                fermi_e = meta.get("fermi_energy") or 0.0
                bands_selected = [
                    b["band"] for b in ranges
                    if b.get("min") is not None and b.get("max") is not None
                    and (fermi_e >= b["min"] - 1e-8) and (fermi_e <= b["max"] + 1e-8)
                ]
            except Exception:
                bands_selected = []
        # Fallback to all bands if none matched
        if not bands_selected:
            bands_selected = list(range(1, num_bands + 1))
        else:
            # keep order but drop duplicates
            bands_selected = list(dict.fromkeys(bands_selected))

        # Energy shift: default to Fermi energy, can override via ?iso= or ?shift=
        shift_val = request.args.get("shift", type=float)
        iso_val = request.args.get("iso", type=float)
        if shift_val is None:
            shift_val = iso_val if iso_val is not None else (meta.get("fermi_energy") or 0.0)

        ishift = request.args.get("ishift", default=1, type=int)
        ishift = 1 if ishift is None else max(0, min(2, ishift))

        total = meta["total_points"]
        vecs = meta.get("vectors") or []
        if len(vecs) < 3:
            vecs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

        def _grad_mag(values: List[float]) -> List[float]:
            """Compute |∇E| per grid point in reciprocal space."""
            nx, ny, nz = dims
            if len(values) != nx * ny * nz:
                return [0.0] * (nx * ny * nz)
            import math
            # step sizes along reciprocal vectors
            bvec = vecs
            step = [
                math.sqrt(sum(c * c for c in bvec[0])) / max(1, nx - 1),
                math.sqrt(sum(c * c for c in bvec[1])) / max(1, ny - 1),
                math.sqrt(sum(c * c for c in bvec[2])) / max(1, nz - 1),
            ]
            sx = 1.0 / max(step[0], 1e-12)
            sy = 1.0 / max(step[1], 1e-12)
            sz = 1.0 / max(step[2], 1e-12)

            def idx(ix: int, iy: int, iz: int) -> int:
                # BXSF BANDGRID is stored as i0 -> i1 -> i2, with i2 fastest.
                return iz + nz * (iy + ny * ix)

            out_vals = [0.0] * (nx * ny * nz)
            for iz in range(nz):
                for iy in range(ny):
                    for ix in range(nx):
                        center = idx(ix, iy, iz)
                        vx1 = values[idx(min(nx - 1, ix + 1), iy, iz)]
                        vx0 = values[idx(max(0, ix - 1), iy, iz)]
                        vy1 = values[idx(ix, min(ny - 1, iy + 1), iz)]
                        vy0 = values[idx(ix, max(0, iy - 1), iz)]
                        vz1 = values[idx(ix, iy, min(nz - 1, iz + 1))]
                        vz0 = values[idx(ix, iy, max(0, iz - 1))]
                        dx = (vx1 - vx0) * 0.5 * sx
                        dy = (vy1 - vy0) * 0.5 * sy
                        dz = (vz1 - vz0) * 0.5 * sz
                        out_vals[center] = math.sqrt(dx * dx + dy * dy + dz * dz)
            return out_vals

        out = io.StringIO()
        out.write(f"{dims[0]} {dims[1]} {dims[2]}\n")
        out.write(f"{ishift}\n")
        out.write(f"{len(bands_selected)}\n")
        for v in (vecs[:3] if vecs else []):
            out.write(" ".join(f"{x:.8f}" for x in v[:3]) + "\n")

        band_cache: Dict[int, List[float]] = {}
        for band in bands_selected:
            vals = load_bxsf_band(p, band, total)
            band_cache[band] = vals
            for v in vals:
                out.write(f"{(v - shift_val):.8f}\n")

        # Matrix element block: use |∇E| for color (Fermi velocity magnitude)
        for band in bands_selected:
            vals = band_cache.get(band) or load_bxsf_band(p, band, total)
            grad = _grad_mag(vals)
            for g in grad:
                out.write(f"{g:.8f}\n")

        return app.response_class(out.getvalue(), mimetype="text/plain")

    @app.route("/api/fermi/<mat_id>/bxsf")
    def fermi_bxsf(mat_id: str):
        variant = _request_fermi_variant("soc")
        p = _fermi_file_for(mat_id, variant)
        if not p:
            msg = "未找到无 SOC 的 FS3D.bxsf 文件" if variant == "nosoc" else "未找到 FS3D.bxsf 文件"
            return jsonify({"error": msg, "variant": variant}), 404
        return send_file(
            p,
            mimetype="text/plain",
            as_attachment=True,
            download_name="FS3D.bxsf",
        )

    @app.route("/api/fermi_nosoc/<mat_id>")
    def fermi_meta_nosoc(mat_id: str):
        p = _fermi_file_for(mat_id, "nosoc")
        if not p:
            return jsonify({"available": False, "message": "未找到无 SOC 费米面文件 FS3D.bxsf"})
        try:
            meta = parse_bxsf_meta(p)
            bands = compute_bxsf_band_ranges(p)
        except Exception as e:
            return jsonify({"available": False, "error": str(e)})
        fermi = meta.get("fermi_energy") or 0.0
        bands_info = []
        for b in bands:
            mn = b.get("min")
            mx = b.get("max")
            has = False
            if mn is not None and mx is not None:
                has = (fermi >= mn - 1e-8) and (fermi <= mx + 1e-8)
            bands_info.append({
                "band": b.get("band"),
                "min": mn,
                "max": mx,
                "count": b.get("count"),
                "has_fermi": has,
            })
        return jsonify({
            "available": True,
            "num_bands": meta.get("num_bands"),
            "dims": list(meta.get("dims", [])),
            "fermi_energy": meta.get("fermi_energy"),
            "origin": meta.get("origin"),
            "vectors": meta.get("vectors"),
            "bands": bands_info,
        })

    @app.route("/api/fermi_nosoc/<mat_id>/band/<int:band_idx>")
    def fermi_band_nosoc(mat_id: str, band_idx: int):
        p = _fermi_file_for(mat_id, "nosoc")
        if not p:
            return jsonify({"error": "未找到无 SOC 的 FS3D.bxsf 文件"}), 404
        try:
            meta = parse_bxsf_meta(p)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        num_bands = meta.get("num_bands") or 0
        if band_idx < 1 or band_idx > num_bands:
            return jsonify({"error": f"能带索引超出范围 1..{num_bands}", "num_bands": num_bands}), 400

        total = meta["total_points"]
        try:
            values = load_bxsf_band(p, band_idx, total)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        vmin = min(values) if values else None
        vmax = max(values) if values else None
        return jsonify({
            "band": band_idx,
            "dims": list(meta.get("dims", [])),
            "fermi_energy": meta.get("fermi_energy"),
            "origin": meta.get("origin"),
            "vectors": meta.get("vectors"),
            "values": values,
            "min": vmin,
            "max": vmax,
        })

    @app.route("/api/fermi_nosoc/<mat_id>/frmsf")
    def fermi_frmsf_nosoc(mat_id: str):
        """Return FermiSurfer .frmsf content converted from no-SOC BXSF."""
        p = _fermi_file_for(mat_id, "nosoc")
        if not p:
            return jsonify({"error": "未找到无 SOC 的 FS3D.bxsf 文件"}), 404
        try:
            meta = parse_bxsf_meta(p)
        except Exception as e:
            return jsonify({"error": f"解析 FS3D 失败: {e}"}), 500

        dims = meta.get("dims") or (0, 0, 0)
        num_bands = meta.get("num_bands") or 0
        if not all(dims) or num_bands <= 0:
            return jsonify({"error": "BXSF 头信息缺失"}), 500

        # Decide which bands to include
        bands_param = (request.args.get("bands") or "").strip()
        bands_selected = []
        if bands_param:
            try:
                bands_selected = [
                    b for b in (
                        int(x) for x in re.split(r"[,\s]+", bands_param) if x.strip()
                    )
                    if 1 <= b <= num_bands
                ]
            except Exception:
                bands_selected = []
        if not bands_selected:
            try:
                ranges = compute_bxsf_band_ranges(p)
                fermi_e = meta.get("fermi_energy") or 0.0
                bands_selected = [
                    b["band"] for b in ranges
                    if b.get("min") is not None and b.get("max") is not None
                    and (fermi_e >= b["min"] - 1e-8) and (fermi_e <= b["max"] + 1e-8)
                ]
            except Exception:
                bands_selected = []
        if not bands_selected:
            bands_selected = list(range(1, num_bands + 1))
        else:
            bands_selected = list(dict.fromkeys(bands_selected))

        # Energy shift: default to Fermi energy, can override via ?iso= or ?shift=
        shift_val = request.args.get("shift", type=float)
        iso_val = request.args.get("iso", type=float)
        if shift_val is None:
            shift_val = iso_val if iso_val is not None else (meta.get("fermi_energy") or 0.0)

        ishift = request.args.get("ishift", default=1, type=int)
        ishift = 1 if ishift is None else max(0, min(2, ishift))

        total = meta["total_points"]
        vecs = meta.get("vectors") or []
        if len(vecs) < 3:
            vecs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

        def _grad_mag(values: List[float]) -> List[float]:
            nx, ny, nz = dims
            if len(values) != nx * ny * nz:
                return [0.0] * (nx * ny * nz)
            import math
            bvec = vecs
            step = [
                math.sqrt(sum(c * c for c in bvec[0])) / max(1, nx - 1),
                math.sqrt(sum(c * c for c in bvec[1])) / max(1, ny - 1),
                math.sqrt(sum(c * c for c in bvec[2])) / max(1, nz - 1),
            ]
            sx = 1.0 / max(step[0], 1e-12)
            sy = 1.0 / max(step[1], 1e-12)
            sz = 1.0 / max(step[2], 1e-12)

            def idx(ix: int, iy: int, iz: int) -> int:
                # BXSF BANDGRID is stored as i0 -> i1 -> i2, with i2 fastest.
                return iz + nz * (iy + ny * ix)

            out_vals = [0.0] * (nx * ny * nz)
            for iz in range(nz):
                for iy in range(ny):
                    for ix in range(nx):
                        center = idx(ix, iy, iz)
                        vx1 = values[idx(min(nx - 1, ix + 1), iy, iz)]
                        vx0 = values[idx(max(0, ix - 1), iy, iz)]
                        vy1 = values[idx(ix, min(ny - 1, iy + 1), iz)]
                        vy0 = values[idx(ix, max(0, iy - 1), iz)]
                        vz1 = values[idx(ix, iy, min(nz - 1, iz + 1))]
                        vz0 = values[idx(ix, iy, max(0, iz - 1))]
                        dx = (vx1 - vx0) * 0.5 * sx
                        dy = (vy1 - vy0) * 0.5 * sy
                        dz = (vz1 - vz0) * 0.5 * sz
                        out_vals[center] = math.sqrt(dx * dx + dy * dy + dz * dz)
            return out_vals

        out = io.StringIO()
        out.write(f"{dims[0]} {dims[1]} {dims[2]}\n")
        out.write(f"{ishift}\n")
        out.write(f"{len(bands_selected)}\n")
        for v in (vecs[:3] if vecs else []):
            out.write(" ".join(f"{x:.8f}" for x in v[:3]) + "\n")

        band_cache: Dict[int, List[float]] = {}
        for band in bands_selected:
            vals = load_bxsf_band(p, band, total)
            band_cache[band] = vals
            for v in vals:
                out.write(f"{(v - shift_val):.8f}\n")

        for band in bands_selected:
            vals = band_cache.get(band) or load_bxsf_band(p, band, total)
            grad = _grad_mag(vals)
            for g in grad:
                out.write(f"{g:.8f}\n")

        return app.response_class(out.getvalue(), mimetype="text/plain")

    @app.route("/api/fermi_nosoc/<mat_id>/bxsf")
    def fermi_bxsf_nosoc(mat_id: str):
        p = _fermi_file_for(mat_id, "nosoc")
        if not p:
            return jsonify({"error": "未找到无 SOC 的 FS3D.bxsf 文件"}), 404
        return send_file(
            p,
            mimetype="text/plain",
            as_attachment=True,
            download_name="FS3D.bxsf",
        )

    # ------------------------- MR data APIs -------------------------
    COMP_ORDER = ["xx", "xy", "xz", "yx", "yy", "yz", "zx", "zy", "zz"]

    def _surface_dirs_for(mat_id: str) -> List[str]:
        mr_root = Path(app.config["MR_DIR"])  # type: ignore
        surfaces = ["Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"]
        out = []
        for s in surfaces:
            p = mr_root / s / mat_id
            if p.exists() and p.is_dir():
                out.append(s)
        return out

    def _angle_name_to_vals(name: str) -> Optional[Tuple[float, float]]:
        # Expect like Btheta_90.00_Bphi_0.00
        m = re.match(r"Btheta_([\-\d\.]+)_Bphi_([\-\d\.]+)$", name)
        if not m:
            return None
        try:
            return float(m.group(1)), float(m.group(2))
        except Exception:
            return None

    def _angle_vals_to_name(theta: float, phi: float) -> str:
        return f"Btheta_{theta:.2f}_Bphi_{phi:.2f}"

    def _angle_sequence_for(surface_dir: Path) -> Dict[str, float]:
        """Map raw Btheta/Bphi directory names to the physical sweep angle.

        For non-orthogonal cells, the folders store the global spherical field
        direction needed by the calculation, while angle_sequence.txt preserves
        the intended in-plane sweep order used by rho_vs_angle_*.dat.
        """
        plots_dir = surface_dir.parent / "plots" / surface_dir.name
        seq_path = plots_dir / "angle_sequence.txt"
        if not seq_path.exists():
            return {}
        try:
            names = [ln.strip() for ln in seq_path.read_text(errors="ignore").splitlines() if ln.strip()]
        except Exception:
            return {}
        if not names:
            return {}

        angle_vals: List[float] = []
        try:
            data_files = sorted(plots_dir.glob("rho_vs_angle_*meV_rho_*.dat"))
            if data_files:
                with data_files[0].open("r", errors="ignore") as fh:
                    for ln in fh:
                        s = ln.strip()
                        if not s or s.startswith("#"):
                            continue
                        parts = s.split()
                        if not parts:
                            continue
                        try:
                            angle_vals.append(float(parts[0]))
                        except Exception:
                            continue
                        if len(angle_vals) >= len(names):
                            break
        except Exception:
            angle_vals = []
        if len(angle_vals) < len(names):
            angle_vals = [float(i * 5) for i in range(len(names))]
        return {name: angle_vals[i] for i, name in enumerate(names[:len(angle_vals)])}

    def _angle_dirs_for(surface_dir: Path) -> List[Dict]:
        items: List[Dict] = []
        if not surface_dir.exists():
            return items
        sweep_angles = _angle_sequence_for(surface_dir)
        for d in sorted(surface_dir.iterdir()):
            if not d.is_dir():
                continue
            vals = _angle_name_to_vals(d.name)
            if not vals:
                continue
            theta, phi = vals
            item = {
                "name": d.name,
                "theta": theta,
                "phi": phi,
            }
            if d.name in sweep_angles:
                item["plane_angle"] = sweep_angles[d.name]
            items.append(item)
        return items

    def _list_mu_in_angle(angle_dir: Path) -> List[float]:
        mu_set = set()
        if not angle_dir.exists():
            return []
        for f in angle_dir.iterdir():
            if not f.is_file():
                continue
            m = re.match(r"(rho|sigma)_total_mu_([\-\d\.]+)meV\.dat$", f.name)
            if m:
                try:
                    mu_set.add(float(m.group(2)))
                except Exception:
                    pass
        return sorted(mu_set)

    def _choose_dat_file(angle_dir: Path, mu: float, kind: str) -> Optional[Path]:
        # kind: 'rho' or 'sigma'
        fname = f"{kind}_total_mu_{mu:.1f}meV.dat"
        p = angle_dir / fname
        if p.exists():
            return p
        # try with more decimals if needed (0.0 vs 0)
        # search any file matching pattern for the numeric value string
        pattern = re.compile(rf"^{kind}_total_mu_([\-\d\.]+)meV\.dat$")
        best = None
        try:
            for f in angle_dir.iterdir():
                if not f.is_file():
                    continue
                m = pattern.match(f.name)
                if m:
                    try:
                        v = float(m.group(1))
                        if abs(v - mu) < 1e-6:
                            best = f
                            break
                    except Exception:
                        pass
        except Exception:
            pass
        return best

    def _parse_temps_from_file(path: Path) -> List[float]:
        temps: List[float] = []
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                for ln in f:
                    if ln.startswith("# Tlist"):
                        # e.g., '#  Tlist  =    10.000  40.000 ...'
                        parts = ln.split("=")
                        if len(parts) >= 2:
                            vals = parts[1].strip().split()
                            for v in vals:
                                try:
                                    temps.append(float(v))
                                except Exception:
                                    pass
                        break
                    if ln.startswith("#  T ="):
                        # fallback: collect as we go
                        try:
                            val = float(re.findall(r"T\s*=\s*([\d\.E\+\-]+)", ln)[0])
                            temps.append(val)
                        except Exception:
                            pass
        except Exception:
            return []
        # ensure unique and sorted
        if temps:
            temps = sorted(set(temps))
        return temps

    def _parse_series(path: Path, temp_target: float, comp: str) -> Optional[Dict[str, List[float]]]:
        comp = comp.lower()
        if comp not in COMP_ORDER:
            return None
        col_idx = COMP_ORDER.index(comp) + 1  # 0: Btau, 1..9: comps
        xs: List[float] = []
        ys: List[float] = []
        # scanning mode: go to the block with matching T, then read numeric lines until next '#'
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                in_block = False
                for raw in f:
                    ln = raw.strip()
                    if not ln:
                        continue
                    if ln.startswith("#"):
                        # detect T block header; other comments are ignored
                        if ln.startswith("#  T ="):
                            m = re.findall(r"T\s*=\s*([\d\.E\+\-]+)", ln)
                            if m:
                                tval = float(m[0])
                                # if we were already in target block and see next T, stop
                                if in_block and abs(tval - temp_target) > 1e-6:
                                    break
                                in_block = abs(tval - temp_target) < 1e-6
                            else:
                                # keep state
                                pass
                        continue
                    if not in_block:
                        continue
                    # data line: expect 10 numeric columns (BTau + 9 comps)
                    parts = ln.split()
                    if len(parts) < 10:
                        continue
                    try:
                        btau = float(parts[0])
                        val = float(parts[col_idx])
                        xs.append(btau)
                        ys.append(val)
                    except Exception:
                        continue
        except Exception:
            return None
        if not xs:
            return None
        return {"x": xs, "y": ys}

    def _parse_mu_token(token: str) -> Optional[float]:
        try:
            return float(str(token).replace("p", "."))
        except Exception:
            return None

    def _pick_polar_data_file(base_dir: Path, comp_l: str, mu_target: float) -> Tuple[Optional[Path], Optional[float]]:
        pattern = re.compile(rf"rho_vs_angle_([\-\d]+p\d+)meV_rho_{re.escape(comp_l)}\.dat$")
        candidates: List[Tuple[float, float, Path]] = []
        try:
            for p in base_dir.glob(f"rho_vs_angle_*meV_rho_{comp_l}.dat"):
                m = pattern.match(p.name)
                if not m:
                    continue
                mu_val = _parse_mu_token(m.group(1))
                if mu_val is None:
                    continue
                candidates.append((abs(mu_val - mu_target), mu_val, p))
        except Exception:
            return None, None

        if not candidates:
            return None, None

        candidates.sort(key=lambda t: (t[0], abs(t[1]), t[1]))
        _, mu_found, picked = candidates[0]
        return picked, mu_found

    def _load_polar_series(mat_id: str, surface: str, comp: str, mu_target: float = 0.0) -> Optional[Dict[str, object]]:
        """Load angle-dependent rho data for polar plot.

        Uses file rho_vs_angle_*meV_rho_<comp>.dat under
        MR_DIR/<surface>/plots/<mat_id>, selecting the entry closest to mu_target.
        Returns angles (deg) and a list of series (one per Btau column).
        """
        comp_l = comp.lower()
        if comp_l not in {"xx", "xy", "xz", "yx", "yy", "yz", "zx", "zy", "zz"}:
            return None
        mr_root = Path(app.config["MR_DIR"])  # type: ignore
        base_dir = mr_root / surface / "plots" / mat_id
        path, mu_found = _pick_polar_data_file(base_dir, comp_l, mu_target)
        if not path or not path.exists():
            return None

        angles: List[float] = []
        values_by_series: List[List[float]] = []
        btau_list: List[Optional[float]] = []
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                for raw in f:
                    line = raw.strip()
                    if not line:
                        continue
                    if line.startswith("#"):
                        # header: '# angle  rho_btau_13  rho_btau_33 ...'
                        header = line.lstrip("#").strip()
                        parts = header.split()
                        if parts and parts[0].lower() == "angle":
                            for tok in parts[1:]:
                                m = re.search(r"rho_btau_(\d+)", tok)
                                if m:
                                    try:
                                        raw = float(m.group(1))
                                        # 文件标识如 13,33,53,... 对应 Btau≈2,6,10,...
                                        btau_val = 0.2 * raw - 0.6
                                        btau_list.append(btau_val)
                                    except Exception:
                                        btau_list.append(None)
                        continue

                    parts = line.split()
                    if len(parts) < 2:
                        continue
                    try:
                        ang = float(parts[0])
                    except Exception:
                        continue
                    vals: List[float] = []
                    for tok in parts[1:]:
                        try:
                            vals.append(float(tok))
                        except Exception:
                            vals.append(0.0)
                    if not values_by_series:
                        # initialize per-column lists
                        values_by_series = [[] for _ in range(len(vals))]
                    # align column count
                    ncols = min(len(values_by_series), len(vals))
                    angles.append(ang)
                    for i in range(ncols):
                        values_by_series[i].append(vals[i])
        except Exception:
            return None

        if not angles or not values_by_series:
            return None

        series_out: List[Dict[str, object]] = []
        for idx, vals in enumerate(values_by_series):
            if not vals:
                continue
            btau_val: Optional[float] = btau_list[idx] if idx < len(btau_list) else None
            series_out.append({
                "index": idx,
                "btau": btau_val,
                "values": vals,
            })

        return {"angles": angles, "series": series_out, "mu": mu_found}

    MR_SURFACES = {"Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"}

    def _resolve_material_display_name(mat_id: str) -> str:
        rec = (app.config.get("MATERIAL_BY_ID", {}) or {}).get(mat_id, {})  # type: ignore
        formula_key = (rec.get("reduced_formula") or rec.get("formula") or "").strip()
        sg = rec.get("space_group")
        sg_key = normalize_space_group_token(sg)
        display_formula = formula_key or mat_id.split("_SG")[0]

        mp_meta_by_formula_sg: Dict[Tuple[str, str], Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SG", {})  # type: ignore
        mp_meta_by_formula_single: Dict[str, Dict[str, str]] = app.config.get("MP_META_BY_FORMULA_SINGLE", {})  # type: ignore
        m = mp_meta_by_formula_sg.get((formula_key, sg_key)) if formula_key and sg_key else None
        if not m and formula_key:
            m = mp_meta_by_formula_single.get(formula_key)
        if m and m.get("formula"):
            display_formula = str(m.get("formula"))

        if sg is not None and str(sg).strip():
            return f"{display_formula} (SG {sg})"
        return display_formula

    def _dedup_polar_samples(angles_deg: List[float], values: List[float]) -> Tuple[List[float], List[float]]:
        pairs: List[Tuple[float, float]] = []
        n = min(len(angles_deg), len(values))
        for i in range(n):
            try:
                a = float(angles_deg[i]) * math.pi / 180.0
                v = float(values[i])
            except Exception:
                continue
            a = a % (2.0 * math.pi)
            if a < 0:
                a += 2.0 * math.pi
            pairs.append((a, v))

        if not pairs:
            return [], []
        pairs.sort(key=lambda t: t[0])
        dedup: List[Tuple[float, float]] = []
        eps = 1e-10
        for p in pairs:
            if not dedup or abs(p[0] - dedup[-1][0]) > eps:
                dedup.append(p)
        return [p[0] for p in dedup], [p[1] for p in dedup]

    def _compute_fourier_signature(angles_deg: List[float], values: List[float], max_n: int = 8) -> Optional[Dict[str, object]]:
        theta, y = _dedup_polar_samples(angles_deg, values)
        m = len(y)
        if m < 4:
            return None

        rho0 = sum(y) / m
        rho_abs = abs(rho0)
        rho_min = min(y)
        rho_max = max(y)
        amr_ratio = None
        if abs(rho_min) > 1e-30:
            amr_ratio = (rho_max - rho_min) / rho_min
        rms = None
        if rho_abs > 1e-30:
            rms = math.sqrt(sum((v - rho0) ** 2 for v in y) / m) / rho_abs

        harmonics: List[Dict[str, float]] = []
        ratios: List[float] = []
        for n_h in range(1, max_n + 1):
            a = (2.0 / m) * sum(y[i] * math.cos(n_h * theta[i]) for i in range(m))
            b = (2.0 / m) * sum(y[i] * math.sin(n_h * theta[i]) for i in range(m))
            amp = math.hypot(a, b)
            ratio = (amp / rho_abs) if rho_abs > 1e-30 else 0.0
            harmonics.append({"n": float(n_h), "a": a, "b": b, "amp": amp, "ratio": ratio})
            ratios.append(ratio)

        dominant_n = 1
        dominant_ratio = 0.0
        for i, r in enumerate(ratios):
            if r > dominant_ratio:
                dominant_ratio = r
                dominant_n = i + 1

        return {
            "rho0": rho0,
            "rho_min": rho_min,
            "rho_max": rho_max,
            "amr_ratio": amr_ratio,
            "rms": rms,
            "dominant_n": dominant_n,
            "dominant_ratio": dominant_ratio,
            "ratios": ratios,
            "harmonics": harmonics,
        }

    def _pick_series_by_btau(entries: List[Dict[str, object]], btau_target: Optional[float]) -> Optional[Dict[str, object]]:
        if not entries:
            return None
        if btau_target is None:
            best = None
            best_btau = -1e99
            for e in entries:
                bt = e.get("btau")
                if bt is None:
                    continue
                try:
                    btv = float(bt)
                except Exception:
                    continue
                if btv > best_btau:
                    best_btau = btv
                    best = e
            return best or entries[0]

        best = None
        best_diff = 1e99
        for e in entries:
            bt = e.get("btau")
            if bt is None:
                continue
            try:
                d = abs(float(bt) - btau_target)
            except Exception:
                continue
            if d < best_diff:
                best_diff = d
                best = e
        return best or entries[0]

    def _signature_distance(r1: List[float], r2: List[float]) -> float:
        n = min(len(r1), len(r2))
        if n <= 0:
            return 1e9
        return math.sqrt(sum((float(r1[i]) - float(r2[i])) ** 2 for i in range(n)) / n)

    @lru_cache(maxsize=48)
    def _fourier_signature_catalog(surface: str, comp: str) -> List[Dict[str, object]]:
        idx: List[Dict] = app.config.get("MATERIALS_INDEX", [])  # type: ignore
        out: List[Dict[str, object]] = []
        for rec in idx:
            mat_id = rec.get("id")
            if not mat_id:
                continue
            data = _load_polar_series(str(mat_id), surface, comp)
            if not data:
                continue
            angles = data.get("angles") or []
            series = data.get("series") or []
            entries: List[Dict[str, object]] = []
            for s in series:
                vals = s.get("values") or []
                sig = _compute_fourier_signature(angles, vals, 8)
                if not sig:
                    continue
                bt = s.get("btau")
                btv = None
                if bt is not None:
                    try:
                        btv = float(bt)
                    except Exception:
                        btv = None
                entries.append({
                    "btau": btv,
                    "signature": sig,
                })
            if entries:
                out.append({
                    "id": str(mat_id),
                    "name": _resolve_material_display_name(str(mat_id)),
                    "entries": entries,
                })
        return out

    @app.route("/api/mr/<mat_id>/surfaces")
    def mr_surfaces(mat_id: str):
        return jsonify({"surfaces": _surface_dirs_for(mat_id)})

    @app.route("/api/mr/<mat_id>/<surface>/angles")
    def mr_angles(mat_id: str, surface: str):
        if surface not in {"Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"}:
            return jsonify({"angles": []})
        base = Path(app.config["MR_DIR"]) / surface / mat_id  # type: ignore
        angles = _angle_dirs_for(base)
        return jsonify({"angles": angles})

    @app.route("/api/mr/<mat_id>/<surface>/angles/<angle>/mus")
    def mr_mus(mat_id: str, surface: str, angle: str):
        base = Path(app.config["MR_DIR"]) / surface / mat_id / angle  # type: ignore
        mus = _list_mu_in_angle(base)
        return jsonify({"mus": mus})

    @app.route("/api/mr/<mat_id>/<surface>/angles/<angle>/temps")
    def mr_temps(mat_id: str, surface: str, angle: str):
        mu = request.args.get("mu", type=float)
        base = Path(app.config["MR_DIR"]) / surface / mat_id / angle  # type: ignore
        temps: List[float] = []
        if mu is not None:
            # prefer rho file; fallback to sigma
            p = _choose_dat_file(base, mu, "rho") or _choose_dat_file(base, mu, "sigma")
            if p:
                temps = _parse_temps_from_file(p)
        return jsonify({"temps": temps})

    @app.route("/api/mr/<mat_id>/series")
    def mr_series(mat_id: str):
        surface = request.args.get("surface", type=str)
        angle = request.args.get("angle", type=str)
        mu = request.args.get("mu", type=float)
        temp = request.args.get("T", type=float)
        comp = request.args.get("comp", type=str, default="xx")
        if not surface or not angle or mu is None or temp is None:
            return jsonify({"error": "missing parameters"}), 400
        base = Path(app.config["MR_DIR"]) / surface / mat_id / angle  # type: ignore
        out: Dict[str, Optional[Dict[str, List[float]]]] = {"rho": None, "sigma": None}
        # rho
        pr = _choose_dat_file(base, mu, "rho")
        if pr and pr.exists():
            out["rho"] = _parse_series(pr, temp, comp)
        # sigma
        ps = _choose_dat_file(base, mu, "sigma")
        if ps and ps.exists():
            out["sigma"] = _parse_series(ps, temp, comp)
        return jsonify(out)

    @app.route("/api/mr/<mat_id>/<surface>/polar/<comp>")
    def mr_polar_data(mat_id: str, surface: str, comp: str):
        if surface not in MR_SURFACES:
            return jsonify({"error": "invalid surface"}), 404
        comp_l = comp.lower()
        if comp_l not in {"xx", "xy", "xz", "yx", "yy", "yz", "zx", "zy", "zz"}:
            return jsonify({"error": "invalid component"}), 404
        mu_q = request.args.get("mu", default=0.0, type=float)
        mu_target = float(mu_q) if mu_q is not None else 0.0
        data = _load_polar_series(mat_id, surface, comp_l, mu_target)
        if not data:
            return jsonify({"error": "not found"}), 404
        # Compute anisotropy ratio at Btau≈10, mu=0 (from rho_vs_angle_0p0meV_rho_*.dat)
        ratio_val: Optional[float] = None
        btau_found: Optional[float] = None
        try:
            series = data.get("series") or []
            # choose series whose btau is closest to 10 (fallback: first)
            target = 10.0
            best = None
            for s in series:
                bt = s.get("btau")
                if bt is None:
                    continue
                diff = abs(bt - target)
                if best is None or diff < best[0]:
                    best = (diff, bt, s)
            if best is None and series:
                # no btau info; fallback to first series
                best = (0.0, None, series[0])
            if best:
                _, bt_val, s = best
                vals = s.get("values") or []
                finite_vals = [float(v) for v in vals if v is not None]
                if finite_vals:
                    vmin = min(finite_vals)
                    vmax = max(finite_vals)
                    if vmin != 0:
                        ratio_val = vmax / vmin
                    btau_found = bt_val
        except Exception:
            ratio_val = None
        data_out = dict(data)
        data_out["mu_requested"] = mu_target
        data_out["mu_found"] = data.get("mu")
        data_out["btau10_ratio"] = ratio_val
        data_out["btau10_found"] = btau_found
        return jsonify(data_out)

    @app.route("/api/mr/<mat_id>/<surface>/similar/<comp>")
    def mr_similar_fingerprint(mat_id: str, surface: str, comp: str):
        if surface not in MR_SURFACES:
            return jsonify({"error": "invalid surface"}), 404
        comp_l = comp.lower()
        if comp_l not in {"xx", "yy", "zz"}:
            return jsonify({"error": "invalid component"}), 404

        btau_q = request.args.get("btau", type=float)
        topk = request.args.get("topk", default=500, type=int) or 500
        topk = max(1, min(2000, topk))
        min_similarity = request.args.get("min_similarity", default=None, type=float)

        catalog = _fourier_signature_catalog(surface, comp_l)
        if not catalog:
            return jsonify({"target": None, "items": [], "count": 0})

        target_rec = next((r for r in catalog if r.get("id") == mat_id), None)
        if not target_rec:
            return jsonify({"error": "target material has no polar data"}), 404
        target_entry = _pick_series_by_btau(target_rec.get("entries", []), btau_q)
        if not target_entry:
            return jsonify({"error": "target series not found"}), 404
        target_sig = target_entry.get("signature") or {}
        target_ratios = target_sig.get("ratios") or []

        items: List[Dict[str, object]] = []
        for rec in catalog:
            mid = rec.get("id")
            if not mid or mid == mat_id:
                continue
            cand_entry = _pick_series_by_btau(rec.get("entries", []), target_entry.get("btau"))
            if not cand_entry:
                continue
            cand_sig = cand_entry.get("signature") or {}
            cand_ratios = cand_sig.get("ratios") or []
            dist = _signature_distance(target_ratios, cand_ratios)
            sim = 1.0 / (1.0 + dist)
            items.append({
                "id": mid,
                "name": rec.get("name") or str(mid),
                "url": f"/m/{mid}",
                "distance": dist,
                "similarity": sim,
                "btau": cand_entry.get("btau"),
                "dominant_n": cand_sig.get("dominant_n"),
                "dominant_ratio": cand_sig.get("dominant_ratio"),
            })

        items.sort(key=lambda x: (x.get("distance", 1e9), x.get("id", "")))
        if min_similarity is not None:
            items = [x for x in items if float(x.get("similarity", 0.0)) >= float(min_similarity)]
        items = items[:topk]
        return jsonify({
            "target": {
                "id": mat_id,
                "name": _resolve_material_display_name(mat_id),
                "btau": target_entry.get("btau"),
                "dominant_n": target_sig.get("dominant_n"),
                "dominant_ratio": target_sig.get("dominant_ratio"),
            },
            "surface": surface,
            "component": comp_l,
            "btau_query": btau_q,
            "min_similarity": min_similarity,
            "items": items,
            "count": len(items),
        })

    @app.route("/api/mr/<mat_id>/similar_all")
    def mr_similar_fingerprint_all(mat_id: str):
        btau_q = request.args.get("btau", type=float)
        topk = request.args.get("topk", default=500, type=int) or 500
        topk = max(1, min(2000, topk))
        min_similarity = request.args.get("min_similarity", default=None, type=float)

        surfaces = ["Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"]
        comps = ["xx", "yy", "zz"]
        combo_keys = [(s, c) for s in surfaces for c in comps]

        # Collect per-material signatures for every (surface, component) combo.
        # Require full 3x3 coverage for the candidate list.
        mat_map: Dict[str, Dict[Tuple[str, str], Dict[str, object]]] = defaultdict(dict)
        for s, c in combo_keys:
            catalog = _fourier_signature_catalog(s, c)
            for rec in catalog:
                rid = str(rec.get("id") or "")
                if not rid:
                    continue
                entry = _pick_series_by_btau(rec.get("entries", []), btau_q)
                if not entry:
                    continue
                sig = entry.get("signature") or {}
                ratios = sig.get("ratios") or []
                if not ratios:
                    continue
                mat_map[rid][(s, c)] = {
                    "ratios": [float(x) for x in ratios],
                    "btau": entry.get("btau"),
                    "dominant_n": sig.get("dominant_n"),
                    "dominant_ratio": sig.get("dominant_ratio"),
                }

        target_combo = mat_map.get(mat_id) or {}
        missing_target = [f"{s}:{c}" for (s, c) in combo_keys if (s, c) not in target_combo]
        if missing_target:
            return jsonify({
                "error": "target material missing combo data",
                "target": {"id": mat_id, "name": _resolve_material_display_name(mat_id)},
                "missing_combos": missing_target,
                "items": [],
                "count": 0,
            }), 404

        items: List[Dict[str, object]] = []
        for rid, combo_data in mat_map.items():
            if rid == mat_id:
                continue
            if any((s, c) not in combo_data for (s, c) in combo_keys):
                continue

            dists: List[float] = []
            dom_match = 0
            btau_vals: List[float] = []
            for key in combo_keys:
                t = target_combo[key]
                u = combo_data[key]
                d = _signature_distance(t.get("ratios") or [], u.get("ratios") or [])
                dists.append(d)
                try:
                    if int(t.get("dominant_n") or 0) == int(u.get("dominant_n") or -1):
                        dom_match += 1
                except Exception:
                    pass
                bt = u.get("btau")
                if bt is not None:
                    try:
                        btau_vals.append(float(bt))
                    except Exception:
                        pass

            if not dists:
                continue
            dist_mean = sum(dists) / len(dists)
            dist_max = max(dists)
            sim = 1.0 / (1.0 + dist_mean)
            sim_min = 1.0 / (1.0 + dist_max)
            btau_repr = (sum(btau_vals) / len(btau_vals)) if btau_vals else None
            items.append({
                "id": rid,
                "name": _resolve_material_display_name(rid),
                "url": f"/m/{rid}",
                "distance_mean": dist_mean,
                "distance_max": dist_max,
                "similarity": sim,
                "similarity_min": sim_min,
                "dominant_match_count": dom_match,
                "btau": btau_repr,
            })

        items.sort(key=lambda x: (-float(x.get("similarity_min", 0.0)), x.get("distance_mean", 1e9), x.get("id", "")))
        if min_similarity is not None:
            # Strict global criterion: every plane/component combo must pass.
            items = [x for x in items if float(x.get("similarity_min", 0.0)) >= float(min_similarity)]
        items = items[:topk]

        bt_target_vals: List[float] = []
        for key in combo_keys:
            bt = target_combo[key].get("btau")
            if bt is not None:
                try:
                    bt_target_vals.append(float(bt))
                except Exception:
                    pass
        bt_target_repr = (sum(bt_target_vals) / len(bt_target_vals)) if bt_target_vals else None

        return jsonify({
            "target": {
                "id": mat_id,
                "name": _resolve_material_display_name(mat_id),
                "btau": bt_target_repr,
            },
            "combos": [f"{s}:{c}" for (s, c) in combo_keys],
            "btau_query": btau_q,
            "min_similarity": min_similarity,
            "items": items,
            "count": len(items),
        })

    # ------------------------- Band structure APIs -------------------------
    def _parse_vasprun_bands(path: Path) -> Optional[Dict[str, object]]:
        """Parse minimal band info from vasprun.xml (k-point list + eigenvalues, shifted by Efermi)."""
        try:
            tree = ET.parse(path)
            root = tree.getroot()
        except Exception:
            return None

        efermi = None
        for elem in root.iter():
            tag = elem.tag.split("}")[-1]
            if tag == "i" and elem.attrib.get("name") == "efermi":
                try:
                    efermi = float((elem.text or "").strip())
                except Exception:
                    pass
                break

        kpoints: List[List[float]] = []
        kp_elem = None
        for elem in root.iter():
            tag = elem.tag.split("}")[-1]
            if tag == "varray" and elem.attrib.get("name") == "kpointlist":
                kp_elem = elem
                break
        if kp_elem is not None:
            for v in kp_elem.findall("v"):
                try:
                    kpoints.append([float(x) for x in (v.text or "").split()[:3]])
                except Exception:
                    continue

        eigenvals: List[List[List[float]]] = []
        # VASP 5+ stores eigenvalues under <eigenvalues><array>... without name attr
        eig_arrays = root.findall(".//eigenvalues/array")
        if eig_arrays:
            eig_elem = eig_arrays[-1]  # take last (final step)
            spin_sets = []
            for spin_set in eig_elem.findall("./set/set"):
                k_list: List[List[float]] = []
                for kp_set in spin_set.findall("set"):
                    band_list: List[float] = []
                    for r in kp_set.findall("r"):
                        parts = (r.text or "").split()
                        if not parts:
                            continue
                        try:
                            band_list.append(float(parts[0]))
                        except Exception:
                            continue
                    if band_list:
                        k_list.append(band_list)
                if k_list:
                    spin_sets.append(k_list)
            eigenvals = spin_sets

        if not kpoints or not eigenvals:
            return None
        k_spin = eigenvals[0] if eigenvals else []
        if not k_spin or not k_spin[0]:
            return None
        nbands = len(k_spin[0])
        nk = len(k_spin)
        bands: List[List[float]] = []
        shift = efermi or 0.0
        for b in range(nbands):
            bands.append([(k_spin[k][b] - shift) for k in range(nk)])
        dists = [0.0]
        for i in range(1, len(kpoints)):
            prev = kpoints[i - 1]
            cur = kpoints[i]
            delta = ((cur[0] - prev[0]) ** 2 + (cur[1] - prev[1]) ** 2 + (cur[2] - prev[2]) ** 2) ** 0.5
            dists.append(dists[-1] + delta)
        return {
            "kdist": dists,
            "kpoints": kpoints,
            "bands": bands,
            "efermi": efermi,
            "nbands": nbands,
            "nkpoints": nk,
        }

    def _parse_poscar_lattice(path: Path) -> Optional[List[List[float]]]:
        if not path.exists():
            return None
        try:
            lines = path.read_text().splitlines()
        except Exception:
            return None
        if len(lines) < 5:
            return None
        try:
            scale = float(lines[1].split()[0])
        except Exception:
            return None
        if scale == 0:
            return None
        if scale < 0:
            scale = abs(scale)
        vecs: List[List[float]] = []
        for i in range(2, 5):
            parts = lines[i].split()
            if len(parts) < 3:
                return None
            try:
                vecs.append([float(parts[0]) * scale, float(parts[1]) * scale, float(parts[2]) * scale])
            except Exception:
                return None
        return vecs

    def _cross(a: List[float], b: List[float]) -> List[float]:
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]

    def _dot(a: List[float], b: List[float]) -> float:
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

    def _reciprocal_from_lattice(lattice: List[List[float]]) -> Optional[List[List[float]]]:
        if len(lattice) != 3:
            return None
        a1, a2, a3 = lattice
        v = _dot(a1, _cross(a2, a3))
        if abs(v) < 1e-12:
            return None
        b1 = [x / v for x in _cross(a2, a3)]
        b2 = [x / v for x in _cross(a3, a1)]
        b3 = [x / v for x in _cross(a1, a2)]
        return [b1, b2, b3]

    def _solve3(mat: List[List[float]], rhs: List[float]) -> Optional[List[float]]:
        det = (
            mat[0][0] * (mat[1][1] * mat[2][2] - mat[1][2] * mat[2][1])
            + mat[0][1] * (mat[1][2] * mat[2][0] - mat[1][0] * mat[2][2])
            + mat[0][2] * (mat[1][0] * mat[2][1] - mat[1][1] * mat[2][0])
        )
        if abs(det) < 1e-12:
            return None
        c0 = (
            rhs[0] * (mat[1][1] * mat[2][2] - mat[1][2] * mat[2][1])
            + rhs[1] * (mat[0][2] * mat[2][1] - mat[0][1] * mat[2][2])
            + rhs[2] * (mat[0][1] * mat[1][2] - mat[0][2] * mat[1][1])
        )
        c1 = (
            rhs[0] * (mat[1][2] * mat[2][0] - mat[1][0] * mat[2][2])
            + rhs[1] * (mat[0][0] * mat[2][2] - mat[0][2] * mat[2][0])
            + rhs[2] * (mat[0][2] * mat[1][0] - mat[0][0] * mat[1][2])
        )
        c2 = (
            rhs[0] * (mat[1][0] * mat[2][1] - mat[1][1] * mat[2][0])
            + rhs[1] * (mat[0][1] * mat[2][0] - mat[0][0] * mat[2][1])
            + rhs[2] * (mat[0][0] * mat[1][1] - mat[0][1] * mat[1][0])
        )
        return [c0 / det, c1 / det, c2 / det]

    def _compute_bz_lines(bvec: List[List[float]]) -> List[List[List[float]]]:
        bragg: List[List[float]] = []
        brnrm: List[float] = []
        for i0 in (-1, 0, 1):
            for i1 in (-1, 0, 1):
                for i2 in (-1, 0, 1):
                    if i0 == 0 and i1 == 0 and i2 == 0:
                        continue
                    vec = [
                        0.5 * (i0 * bvec[0][0] + i1 * bvec[1][0] + i2 * bvec[2][0]),
                        0.5 * (i0 * bvec[0][1] + i1 * bvec[1][1] + i2 * bvec[2][1]),
                        0.5 * (i0 * bvec[0][2] + i1 * bvec[1][2] + i2 * bvec[2][2]),
                    ]
                    bragg.append(vec)
                    brnrm.append(_dot(vec, vec))

        def bragg_vert(ibr: int, jbr: int, nbr: int, vert: List[float], vert2: List[float]) -> int:
            for kbr in range(nbr, 26):
                mat = [bragg[ibr][:], bragg[jbr][:], bragg[kbr][:]]
                rhs = [brnrm[ibr], brnrm[jbr], brnrm[kbr]]
                thr = (rhs[0] * rhs[1] * rhs[2]) ** 0.5 * 0.001
                sol = _solve3(mat, rhs)
                if sol is None:
                    continue
                if sum((vert2[i] - sol[i]) ** 2 for i in range(3)) < thr:
                    continue
                inside = True
                for lbr in range(26):
                    prod = bragg[lbr][0] * sol[0] + bragg[lbr][1] * sol[1] + bragg[lbr][2] * sol[2]
                    if prod > brnrm[lbr] + thr:
                        inside = False
                        break
                if inside:
                    vert[:] = sol
                    return kbr + 1
            return 0

        lines: List[List[List[float]]] = []
        for ibr in range(26):
            for jbr in range(26):
                v0 = [0.0, 0.0, 0.0]
                v1 = [0.0, 0.0, 0.0]
                nbr = 0
                nxt = bragg_vert(ibr, jbr, nbr, v0, v1)
                if nxt == 0:
                    continue
                nbr = nxt
                nxt = bragg_vert(ibr, jbr, nbr, v1, v0)
                if nxt == 0:
                    continue
                lines.append([v0[:], v1[:]])
        return lines

    def _build_bz_points(
        segments: List[Dict[str, object]], bvec: List[List[float]], tol: float = 1e-6
    ) -> List[Dict[str, object]]:
        points: List[Dict[str, object]] = []
        bragg: List[List[float]] = []
        brnrm: List[float] = []
        for i0 in (-1, 0, 1):
            for i1 in (-1, 0, 1):
                for i2 in (-1, 0, 1):
                    if i0 == 0 and i1 == 0 and i2 == 0:
                        continue
                    vec = [
                        0.5 * (i0 * bvec[0][0] + i1 * bvec[1][0] + i2 * bvec[2][0]),
                        0.5 * (i0 * bvec[0][1] + i1 * bvec[1][1] + i2 * bvec[2][1]),
                        0.5 * (i0 * bvec[0][2] + i1 * bvec[1][2] + i2 * bvec[2][2]),
                    ]
                    bragg.append(vec)
                    brnrm.append(_dot(vec, vec))

        def frac_to_cart(frac: List[float]) -> List[float]:
            return [
                frac[0] * bvec[0][0] + frac[1] * bvec[1][0] + frac[2] * bvec[2][0],
                frac[0] * bvec[0][1] + frac[1] * bvec[1][1] + frac[2] * bvec[2][1],
                frac[0] * bvec[0][2] + frac[1] * bvec[1][2] + frac[2] * bvec[2][2],
            ]

        def first_bz_score(cart: List[float]) -> Tuple[float, float]:
            outside = 0.0
            max_over = -float("inf")
            for plane, norm in zip(bragg, brnrm):
                over = _dot(plane, cart) - norm
                max_over = max(max_over, over)
                if over > 0:
                    outside += over * over
            return outside, max_over

        def fold_frac_to_first_bz(frac: List[float]) -> List[float]:
            # KPOINTS paths sometimes use a periodic image of a high-symmetry point.
            # For the BZ overlay, show the equivalent image inside or closest to the first BZ.
            base = [float(frac[0]), float(frac[1]), float(frac[2])]
            best_cart = frac_to_cart(base)
            best_score = first_bz_score(best_cart)
            best_radius = _dot(best_cart, best_cart)
            for s0 in (-1, 0, 1):
                for s1 in (-1, 0, 1):
                    for s2 in (-1, 0, 1):
                        trial = [base[0] + s0, base[1] + s1, base[2] + s2]
                        cart = frac_to_cart(trial)
                        score = first_bz_score(cart)
                        radius = _dot(cart, cart)
                        if (
                            score[0] < best_score[0] - 1e-18
                            or (
                                abs(score[0] - best_score[0]) <= 1e-18
                                and (
                                    score[1] < best_score[1] - 1e-12
                                    or (abs(score[1] - best_score[1]) <= 1e-12 and radius < best_radius)
                                )
                            )
                        ):
                            best_cart = cart
                            best_score = score
                            best_radius = radius
            return best_cart

        def add_point(label: str, frac: List[float]) -> None:
            if not label or len(frac) < 3:
                return
            cart = fold_frac_to_first_bz(frac)
            for p in points:
                dx = p["point"][0] - cart[0]
                dy = p["point"][1] - cart[1]
                dz = p["point"][2] - cart[2]
                if dx * dx + dy * dy + dz * dz <= tol * tol:
                    existing = str(p["label"] or "")
                    if label not in existing.split("|"):
                        p["label"] = f"{existing}|{label}" if existing else label
                    return
            points.append({"label": label, "point": cart})

        for seg in segments:
            add_point(str(seg.get("start_label") or ""), seg.get("start_coords") or [])
            add_point(str(seg.get("end_label") or ""), seg.get("end_coords") or [])
        return points

    def _parse_kpoints_segments(path: Path) -> Optional[Dict[str, object]]:
        """Parse line-mode KPOINTS into segments with labels and points-per-segment."""
        if not path.exists():
            return None
        try:
            raw = path.read_text().splitlines()
        except Exception:
            return None
        if len(raw) < 5:
            return None
        n_per_seg = None
        try:
            n_per_seg = int(raw[1].split()[0])
            if n_per_seg <= 0:
                n_per_seg = None
        except Exception:
            n_per_seg = None
        data_lines = raw[4:]
        segments: List[List[str]] = []
        cur: List[str] = []
        for ln in data_lines:
            if not ln.strip():
                if cur:
                    segments.append(cur)
                    cur = []
                continue
            cur.append(ln.strip())
        if cur:
            segments.append(cur)
        if not segments:
            return None

        def parse_line(ln: str) -> Dict[str, object]:
            parts = ln.split("!")
            coords = [float(x) for x in parts[0].split()[:3]] if parts[0].split() else []
            label = parts[1].strip() if len(parts) > 1 else ""
            if label == "G":
                label = "Γ"
            label = label.replace("\\Gamma", "Γ")
            return {"coords": coords, "label": label}

        parsed_segments: List[Dict[str, object]] = []
        for seg in segments:
            if len(seg) < 2:
                continue
            start = parse_line(seg[0])
            end = parse_line(seg[-1])
            parsed_segments.append(
                {
                    "start_label": start["label"],
                    "end_label": end["label"],
                    "start_coords": start["coords"],
                    "end_coords": end["coords"],
                }
            )
        if not parsed_segments:
            return None
        return {"n_per_seg": n_per_seg, "segments": parsed_segments}

    def _build_kdist_with_segments(
        kpoints: List[List[float]], n_per_seg: int, nseg: int
    ) -> Optional[List[float]]:
        if not kpoints or not n_per_seg or n_per_seg <= 0 or nseg <= 0:
            return None
        if len(kpoints) != n_per_seg * nseg:
            return None
        dists = [0.0]
        for i in range(1, len(kpoints)):
            if i % n_per_seg == 0:
                dists.append(dists[-1])
                continue
            prev = kpoints[i - 1]
            cur = kpoints[i]
            delta = ((cur[0] - prev[0]) ** 2 + (cur[1] - prev[1]) ** 2 + (cur[2] - prev[2]) ** 2) ** 0.5
            dists.append(dists[-1] + delta)
        return dists

    def _merge_ticks_by_pos(ticks: List[Dict[str, object]], tol: float = 1e-6) -> List[Dict[str, object]]:
        merged: List[Dict[str, object]] = []
        for t in ticks:
            pos = float(t.get("pos", 0.0))
            label = str(t.get("label", "") or "")
            if not label:
                continue
            if merged and abs(float(merged[-1].get("pos", 0.0)) - pos) <= tol:
                prev = str(merged[-1].get("label", "") or "")
                if label not in prev.split("|"):
                    merged[-1]["label"] = f"{prev}|{label}" if prev else label
            else:
                merged.append({"pos": pos, "label": label})
        return merged

    def _parse_kpoints_ticks_by_coords(
        path: Path, kpoints: List[List[float]], tol: float = 1e-4
    ) -> List[Dict[str, object]]:
        """Fallback: align labels by coordinates."""
        if not path.exists() or not kpoints:
            return []
        try:
            lines = [ln.strip() for ln in path.read_text().splitlines() if ln.strip()]
            if len(lines) < 5:
                return []
            pts = []
            for ln in lines[3:]:
                parts = ln.split("!")
                coords = parts[0].split()
                if len(coords) < 3:
                    continue
                label = parts[1].strip() if len(parts) > 1 else ""
                if label == "G":
                    label = "Γ"
                label = label.replace("\\Gamma", "Γ")
                pts.append({"label": label, "coords": coords})
            if len(pts) < 2:
                return []
            dedup = []
            last = None
            for p in pts:
                coord = tuple(p["coords"])
                if coord == last:
                    continue
                dedup.append(p)
                last = coord
            pts = dedup
            if len(pts) < 2:
                return []
            ticks = []
            start_idx = 0
            for p in pts:
                target = [float(x) for x in p["coords"][:3]]
                found = None
                for i in range(start_idx, len(kpoints)):
                    kp = kpoints[i]
                    if abs(kp[0] - target[0]) < tol and abs(kp[1] - target[1]) < tol and abs(kp[2] - target[2]) < tol:
                        found = i
                        start_idx = i
                        break
                if found is None:
                    continue
                ticks.append({"idx": found, "label": p["label"]})
            return ticks
        except Exception:
            return []

    def _parse_kpoints_ticks(path: Path, kdist: List[float], n_per_seg: int, segments: List[Dict[str, object]]) -> List[Dict[str, object]]:
        """Build ticks from line-mode segments using kdist positions."""
        if not kdist or not n_per_seg or not segments:
            return []
        nk = len(kdist)
        expected = n_per_seg * len(segments)
        if expected != nk:
            return []
        ticks: List[Dict[str, object]] = []
        for i, seg in enumerate(segments):
            start_idx = i * n_per_seg
            end_idx = start_idx + n_per_seg - 1
            start_label = str(seg.get("start_label") or "")
            if start_label:
                ticks.append({"pos": kdist[start_idx], "label": start_label})
            end_label = str(seg.get("end_label") or "")
            if end_label:
                ticks.append({"pos": kdist[end_idx], "label": end_label})
        return _merge_ticks_by_pos(ticks)

    @app.route("/api/band/<mat_id>")
    def band_data(mat_id: str):
        variant = request.args.get("variant", "soc").lower()
        folder = "band_soc" if variant == "soc" else "band_wosoc"
        root = Path(app.config["BAND_DIR"]) / mat_id / folder  # type: ignore
        vasprun_path = root / "vasprun.xml"
        kpoints_path = root / "KPOINTS"
        poscar_path = root / "POSCAR"
        if not vasprun_path.exists():
            return jsonify({"available": False, "message": f"band data not found for {variant}"})
        data = _parse_vasprun_bands(vasprun_path)
        if not data:
            return jsonify({"available": False, "message": "failed to parse vasprun.xml"})
        ticks: List[Dict[str, object]] = []
        kpoints = data.get("kpoints") or []
        seg_info = _parse_kpoints_segments(kpoints_path)
        if seg_info and kpoints:
            n_per_seg = seg_info.get("n_per_seg") or 0
            segments = seg_info.get("segments") or []
            kdist = _build_kdist_with_segments(kpoints, int(n_per_seg), len(segments))
            if kdist:
                data["kdist"] = kdist
                ticks = _parse_kpoints_ticks(kpoints_path, kdist, int(n_per_seg), segments)
        if not ticks:
            ticks = _parse_kpoints_ticks_by_coords(kpoints_path, kpoints)
        # Brillouin zone lines + tick points (from POSCAR + KPOINTS)
        lattice = _parse_poscar_lattice(poscar_path)
        bvec = _reciprocal_from_lattice(lattice) if lattice else None
        if bvec:
            data["bvec"] = bvec
            data["bz_lines"] = _compute_bz_lines(bvec)
            if seg_info:
                data["bz_points"] = _build_bz_points(seg_info.get("segments") or [], bvec)
        data["available"] = True
        data["variant"] = variant
        if ticks:
            data["ticks"] = ticks
        # remove raw kpoints from response to shrink payload
        data.pop("kpoints", None)
        return jsonify(data)

    @app.route("/mr_polar/<mat_id>/<surface>/<comp>.pdf")
    def mr_polar_pdf(mat_id: str, surface: str, comp: str):
        surface_allowed = {"Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"}
        if surface not in surface_allowed:
            abort(404)
        comp_l = comp.lower()
        if comp_l not in {"xx", "yy", "zz"}:
            abort(404)
        mr_root = Path(app.config["MR_DIR"])  # type: ignore
        pdf_path = mr_root / surface / "plots" / mat_id / f"rho_{comp_l}_polar_all.pdf"
        if not pdf_path.exists():
            abort(404)
        return send_from_directory(str(pdf_path.parent), pdf_path.name)

    @app.route("/mr_cart/<mat_id>/<surface>/<comp>.pdf")
    def mr_cart_pdf(mat_id: str, surface: str, comp: str):
        surface_allowed = {"Ra_Rb_surface", "Rb_Rc_surface", "Rc_Ra_surface"}
        if surface not in surface_allowed:
            abort(404)
        comp_l = comp.lower()
        if comp_l not in {"xx", "xy", "xz", "yx", "yy", "yz", "zx", "zy", "zz"}:
            abort(404)
        mr_root = Path(app.config["MR_DIR"])  # type: ignore
        pdf_path = mr_root / surface / "plots" / mat_id / f"rho_{comp_l}_cart_all.pdf"
        if not pdf_path.exists():
            abort(404)
        return send_from_directory(str(pdf_path.parent), pdf_path.name)

    # (Anisotropy endpoints removed by request)

    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", 1999))
    app.run(host="0.0.0.0", port=port, debug=True)
