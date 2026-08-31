#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DICOM to Float16 Raw Buffer Converter with GPU Perona-Malik Smoothing
Converts DICOM series to raw float16 buffers for WebGPU volume rendering.
Includes optional anonymization for patient data protection.
"""

import os
import sys

# No Windows, stdout redirecionado usa cp1252 e os ✓/✗/⚠ dos prints quebram
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
import json
import argparse
import hashlib
from pathlib import Path
from typing import List, Dict, Any
try:
    import numpy as np
    import pydicom
    from pydicom.errors import InvalidDicomError
except ImportError as e:
    print(f"✗ Dependência ausente: {e.name}")
    print("  Instale as dependências com:")
    print("    pip install -r requirements.txt")
    sys.exit(1)

# Optional GPU acceleration
try:
    import cupy as cp
    HAS_CUPY = True
    print("✓ CuPy detected - GPU acceleration available")
except ImportError:
    HAS_CUPY = False
    print("⚠  CuPy not available - smoothing will be skipped or use CPU (slow)")


def anonymize_identifier(identifier: str, salt: str = "medical_volume_renderer") -> str:
    """
    Anonymize an identifier using SHA256 hashing.
    
    Args:
        identifier: Original identifier to anonymize
        salt: Salt for the hash (default: project name)
        
    Returns:
        Anonymized hash (first 16 characters)
    """
    if not identifier:
        return "UNKNOWN"
    
    # Create hash
    hash_input = f"{salt}:{identifier}".encode('utf-8')
    hash_result = hashlib.sha256(hash_input).hexdigest()
    
    # Return first 16 characters for readability
    return hash_result[:16].upper()


def read_dicom_files(input_dir: Path) -> List[pydicom.FileDataset]:
    """
    Read all DICOM files from the input directory.
    
    Args:
        input_dir: Path to directory containing DICOM files
        
    Returns:
        List of DICOM datasets
    """
    dicom_files = []
    
    print(f"Scanning directory: {input_dir}")
    
    for file_path in input_dir.rglob("*"):
        if file_path.is_file():
            try:
                ds = pydicom.dcmread(str(file_path), force=True)
                # Verify it has pixel data. Checking the raw tag is free;
                # hasattr(ds, 'pixel_array') would decode the pixels just to test.
                if 'PixelData' in ds:
                    dicom_files.append(ds)
                    print(f"  ✓ Loaded: {file_path.name}")
                else:
                    print(f"  ⚠  Skipped (no pixel data): {file_path.name}")
            except InvalidDicomError:
                print(f"  ✗ Skipped (invalid DICOM): {file_path.name}")
            except Exception as e:
                print(f"  ✗ Error reading {file_path.name}: {e}")
    
    print(f"\nFound {len(dicom_files)} valid DICOM files")
    return dicom_files


def group_series(dicom_files: List[pydicom.FileDataset]) -> Dict[Any, List[pydicom.FileDataset]]:
    """
    Group slices by (SeriesInstanceUID, Rows, Columns).

    The shape is part of the key so a series with mixed dimensions can never
    crash the volume assembly.

    Args:
        dicom_files: List of DICOM datasets, possibly from several series

    Returns:
        Dict keyed by (uid, rows, cols), each mapping to that group's slices
    """
    groups: Dict[Any, List[pydicom.FileDataset]] = {}
    for ds in dicom_files:
        key = (
            str(getattr(ds, 'SeriesInstanceUID', 'UNKNOWN')),
            int(getattr(ds, 'Rows', 0)),
            int(getattr(ds, 'Columns', 0)),
        )
        groups.setdefault(key, []).append(ds)
    return groups


def describe_series(groups: Dict[Any, List[pydicom.FileDataset]]) -> str:
    """Render a series inventory, biggest first, one line per group."""
    lines = []
    for (uid, rows, cols), slices in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        first = slices[0]
        desc = str(getattr(first, 'SeriesDescription', '') or '')
        number = str(getattr(first, 'SeriesNumber', '?'))
        modality = str(getattr(first, 'Modality', '') or '')
        lines.append(f"  {len(slices):5d} slices | series {number:>5} | {modality:<3} | "
                     f"{cols}x{rows} | '{desc}' | {uid}")
    return "\n".join(lines)


def filter_series(dicom_files: List[pydicom.FileDataset],
                  series_desc: str = None,
                  series_uid: str = None) -> List[pydicom.FileDataset]:
    """
    Keep only the slices of the requested series.

    A study directory usually holds every series side by side, and the one you
    want is rarely the biggest one (a diffusion series can easily outnumber the
    angiography). SeriesDescription is matched case-insensitively and
    whitespace-trimmed; it is NOT unique (a series and its reconstruction share
    the description), so several groups can survive the filter and
    select_largest_series() then picks the actual volume. SeriesInstanceUID is
    the unambiguous key when that is not good enough.

    Args:
        dicom_files: All slices read from the input directory
        series_desc: SeriesDescription to keep, or None for no filtering
        series_uid: SeriesInstanceUID to keep, or None for no filtering

    Returns:
        The matching slices

    Raises:
        SystemExit: if nothing matches (the available series are listed first)
    """
    if not series_desc and not series_uid:
        return dicom_files

    wanted_desc = series_desc.strip().lower() if series_desc else None

    def matches(ds):
        if series_uid and str(getattr(ds, 'SeriesInstanceUID', '')) != series_uid:
            return False
        if wanted_desc is not None:
            desc = str(getattr(ds, 'SeriesDescription', '') or '').strip().lower()
            if desc != wanted_desc:
                return False
        return True

    kept = [ds for ds in dicom_files if matches(ds)]

    if not kept:
        print("\n✗ No slice matches the requested series.")
        print("  Available series:")
        print(describe_series(group_series(dicom_files)))
        sys.exit(1)

    criterion = series_uid if series_uid else f"'{series_desc}'"
    print(f"\n✓ Series filter {criterion}: kept {len(kept)}/{len(dicom_files)} slices")
    return kept


def slice_normal(ds):
    """
    Unit normal of the slice plane, from the two ImageOrientationPatient
    direction cosines. None when the tag is missing or malformed.
    """
    iop = getattr(ds, 'ImageOrientationPatient', None)
    if iop is None or len(iop) != 6:
        return None
    row = np.array([float(v) for v in iop[:3]])
    col = np.array([float(v) for v in iop[3:]])
    return np.cross(row, col)


def derive_slice_spacing(sorted_files: List[pydicom.FileDataset]) -> float:
    """
    Physical distance between neighbouring slice centres, in mm.

    SliceThickness is the WRONG number to size a volume with: slices routinely
    overlap (thickness 1.2 mm acquired every 0.6 mm) or leave a gap, and using
    it then stretches or squashes the reconstruction along Z. The real step is
    the distance between consecutive slice positions measured along the slice
    normal. The MEDIAN of those distances is used so one missing slice in the
    middle of the series cannot skew it.

    Falls back to SpacingBetweenSlices, then SliceThickness, then 1.0 mm.

    Args:
        sorted_files: Slices already ordered along the scan axis

    Returns:
        Slice spacing in mm (always > 0)
    """
    first = sorted_files[0]

    normal = None
    for ds in sorted_files:
        normal = slice_normal(ds)
        if normal is not None:
            break

    if normal is not None and len(sorted_files) > 1:
        positions = []
        for ds in sorted_files:
            ipp = getattr(ds, 'ImagePositionPatient', None)
            if ipp is not None and len(ipp) == 3:
                position = np.array([float(v) for v in ipp])
                positions.append(float(np.dot(position, normal)))
        if len(positions) > 1:
            steps = np.abs(np.diff(np.array(positions)))
            steps = steps[steps > 1e-6]
            if steps.size:
                spacing = float(np.median(steps))
                thickness = float(getattr(first, 'SliceThickness', 0) or 0)
                note = ""
                if thickness > 0 and abs(thickness - spacing) > 1e-3:
                    note = f"  (SliceThickness is {thickness:g} mm - slices overlap or gap)"
                print(f"Slice spacing: {spacing:.4f} mm from ImagePositionPatient{note}")
                return spacing

    for attr in ('SpacingBetweenSlices', 'SliceThickness'):
        value = getattr(first, attr, None)
        if value:
            spacing = abs(float(value))
            if spacing > 0:
                print(f"Slice spacing: {spacing:.4f} mm from {attr} (no usable positions)")
                return spacing

    print("⚠  Slice spacing unknown, assuming 1.0 mm")
    return 1.0


def select_largest_series(dicom_files: List[pydicom.FileDataset]) -> List[pydicom.FileDataset]:
    """
    Keep only the largest coherent series from the input.

    Real-world DICOM dirs often mix multiple series (axial + scout/localizer,
    reconstructions...). The group with the most slices wins; everything else
    is discarded with a warning.

    Args:
        dicom_files: List of DICOM datasets, possibly from several series

    Returns:
        Slices belonging to the largest series only
    """
    groups = group_series(dicom_files)

    if len(groups) > 1:
        print(f"\n⚠  Input contains {len(groups)} distinct series/shapes:")
        print(describe_series(groups))

    best_key, best_slices = max(groups.items(), key=lambda kv: len(kv[1]))
    if len(best_slices) < len(dicom_files):
        discarded = len(dicom_files) - len(best_slices)
        print(f"⚠  Keeping largest series ({len(best_slices)} slices), discarding {discarded} slice(s)")

    return best_slices


def sort_dicom_slices(dicom_files: List[pydicom.FileDataset]) -> List[pydicom.FileDataset]:
    """
    Sort DICOM slices along the scan axis.

    Preferred key is geometric: ImagePositionPatient projected onto the slice
    normal (cross product of the two ImageOrientationPatient direction cosines).
    InstanceNumber is unreliable in the wild (reconstructions, reordered
    series), so it is only a fallback, followed by SliceLocation.

    Args:
        dicom_files: List of unsorted DICOM datasets

    Returns:
        Sorted list of DICOM datasets
    """
    # All slices of a series share the orientation; take it from the first
    # slice that has one so every sort key uses the SAME normal.
    normal = None
    for ds in dicom_files:
        normal = slice_normal(ds)
        if normal is not None:
            break

    def get_sort_key(ds):
        ipp = getattr(ds, 'ImagePositionPatient', None)
        if normal is not None and ipp is not None and len(ipp) == 3:
            position = np.array([float(v) for v in ipp])
            return float(np.dot(position, normal))
        elif hasattr(ds, 'InstanceNumber') and ds.InstanceNumber is not None:
            return float(ds.InstanceNumber)
        elif hasattr(ds, 'SliceLocation') and ds.SliceLocation is not None:
            return float(ds.SliceLocation)
        else:
            return 0

    sorted_files = sorted(dicom_files, key=get_sort_key)
    method = "ImagePositionPatient·normal" if normal is not None else "InstanceNumber/SliceLocation fallback"
    print(f"Sorted {len(sorted_files)} slices ({method})")
    return sorted_files


def extract_metadata(dicom_files: List[pydicom.FileDataset], global_min: float, global_max: float,
                     slice_spacing: float, anonymize: bool = True) -> Dict[str, Any]:
    """
    Extract relevant metadata from DICOM series.
    
    Args:
        dicom_files: List of DICOM datasets
        global_min: Minimum HU value across all slices
        global_max: Maximum HU value across all slices
        slice_spacing: Real distance between slice centres in mm (see
            derive_slice_spacing) - this, not sliceThickness, sizes the volume
        anonymize: Whether to anonymize patient identifiers
        
    Returns:
        Dictionary containing series metadata
    """
    if not dicom_files:
        return {}
    
    # Use first file for series-level metadata
    first_ds = dicom_files[0]
    
    # Helper function to safely get DICOM tag value
    def safe_get(ds, attr, default=""):
        try:
            val = getattr(ds, attr, default)
            # Convert to string and handle potential encoding issues
            if isinstance(val, bytes):
                return val.decode('utf-8', errors='replace')
            elif isinstance(val, pydicom.multival.MultiValue):
                return [str(v) for v in val]
            return str(val) if val != default else default
        except:
            return default
    
    # Get pixel array shape from first slice
    pixel_array = first_ds.pixel_array
    
    # Get original identifiers
    patient_name = safe_get(first_ds, 'PatientName')
    patient_id = safe_get(first_ds, 'PatientID')
    study_uid = safe_get(first_ds, 'StudyInstanceUID')
    series_uid = safe_get(first_ds, 'SeriesInstanceUID')
    
    # Anonymize if requested
    if anonymize:
        patient_name = f"ANON_{anonymize_identifier(patient_name)}"
        patient_id = f"ID_{anonymize_identifier(patient_id)}"
        # Keep UID structure but anonymize - ensure we don't exceed bounds
        study_uid_str = str(study_uid)
        series_uid_str = str(series_uid)
        study_uid = f"STUDY_{anonymize_identifier(study_uid_str[:min(len(study_uid_str), 64)])}"
        series_uid = f"SERIES_{anonymize_identifier(series_uid_str[:min(len(series_uid_str), 64)])}"
    
    metadata = {
        "numSlices": len(dicom_files),
        "width": int(pixel_array.shape[1]),
        "height": int(pixel_array.shape[0]),
        "format": "float16",
        "bytesPerVoxel": 2,
        "anonymized": anonymize,
        
        # Patient information (anonymized if requested)
        "patientName": patient_name,
        "patientID": patient_id,
        "patientBirthDate": safe_get(first_ds, 'PatientBirthDate'),
        "patientSex": safe_get(first_ds, 'PatientSex'),
        
        # Study information
        "studyDate": safe_get(first_ds, 'StudyDate'),
        "studyTime": safe_get(first_ds, 'StudyTime'),
        "studyDescription": safe_get(first_ds, 'StudyDescription'),
        "studyInstanceUID": study_uid,
        
        # Series information
        "seriesNumber": safe_get(first_ds, 'SeriesNumber'),
        "seriesDescription": safe_get(first_ds, 'SeriesDescription'),
        "seriesInstanceUID": series_uid,
        "modality": safe_get(first_ds, 'Modality'),
        
        # Image information
        "pixelSpacing": safe_get(first_ds, 'PixelSpacing'),
        "sliceThickness": safe_get(first_ds, 'SliceThickness'),
        "spacingBetweenSlices": safe_get(first_ds, 'SpacingBetweenSlices'),
        # Distance between slice centres in mm, derived from the slice
        # positions. Use THIS to size the volume along Z: sliceThickness is
        # the slab thickness and does not match the step when slices overlap.
        "sliceSpacing": float(slice_spacing),
        "imageOrientationPatient": safe_get(first_ds, 'ImageOrientationPatient'),
        "imagePositionPatient": safe_get(first_ds, 'ImagePositionPatient'),
        
        # Window/Level (for display)
        "windowCenter": safe_get(first_ds, 'WindowCenter'),
        "windowWidth": safe_get(first_ds, 'WindowWidth'),
        
        # Rescale parameters
        "rescaleSlope": safe_get(first_ds, 'RescaleSlope', '1.0'),
        "rescaleIntercept": safe_get(first_ds, 'RescaleIntercept', '0.0'),
        
        # Value range (in Hounsfield Units for CT)
        "huMin": float(global_min),
        "huMax": float(global_max),
    }
    
    return metadata


def choose_slab_depth(depth: int, height: int, width: int,
                      vram_fraction: float = 0.6) -> int:
    """
    How many slices to diffuse at once so the GPU working set fits in VRAM.

    One slab costs about SLAB_BUFFERS arrays of its own size: the padded input,
    the accumulating divergence, the result, and the two or three temporaries
    alive inside the per-neighbour step. Only a fraction of the FREE VRAM is
    claimed, because the driver, CuPy's own pools and whatever else is on the
    display adapter also need room.

    Args:
        depth, height, width: Volume shape (Z, Y, X)
        vram_fraction: Share of the currently free VRAM to spend

    Returns:
        Slice count per slab, clamped to [1, depth]
    """
    SLAB_BUFFERS = 8
    slice_bytes = height * width * 4  # float32

    try:
        free_bytes, _total = cp.cuda.Device().mem_info
    except Exception:
        free_bytes = 1 << 30  # sem info confiável: assume 1 GB e segue

    budget = int(free_bytes * vram_fraction)
    slab = budget // (SLAB_BUFFERS * slice_bytes)
    return int(max(1, min(depth, slab)))


def perona_malik_gpu(volume: np.ndarray, iterations: int = 5, K: float = 50.0,
                     lambda_param: float = 0.1, diffusion_type: int = 1) -> np.ndarray:
    """
    Apply Perona-Malik anisotropic diffusion using GPU acceleration via CuPy.

    The volume stays in host memory and is diffused SLAB BY SLAB along Z, so
    the GPU working set is bounded by the slab size instead of the volume size
    (a 512x512x889 CT needs ~13 GB done whole, which no consumer card has).
    Each slab is uploaded with a 1-voxel halo on each side, because the update
    of a voxel reads its 6 neighbours; the halo comes from the neighbouring
    slabs of the CURRENT iteration, and only the slab's core is written back to
    the next-iteration buffer. Slabbing is therefore exact — bit-for-bit the
    same result as diffusing the whole volume at once, modulo float addition
    order — and NOT an approximation with seams at the slab boundaries.

    At the volume's own Z borders the halo is replicated (edge padding), the
    same convention used on Y and X.

    Args:
        volume: 3D numpy array (Z, Y, X) in HU values (not normalized)
        iterations: Number of diffusion iterations
        K: Edge threshold parameter, in the units of the data (default 50.0,
            tuned for CT Hounsfield units — MR needs a much smaller value)
        lambda_param: Time step (stability requires lambda <= 0.25 for 3D)
        diffusion_type: 1 (exponential) or 2 (rational)

    Returns:
        Smoothed volume as numpy array in HU values
    """
    if not HAS_CUPY:
        print("⚠  CuPy not available - returning unsmoothed volume")
        return volume

    depth, height, width = volume.shape
    slab_depth = choose_slab_depth(depth, height, width)
    num_slabs = (depth + slab_depth - 1) // slab_depth

    print(f"Applying Perona-Malik smoothing on GPU ({iterations} iterations, K={K:g})...")
    print(f"  Slab: {slab_depth} slices x {num_slabs} slabs "
          f"(~{slab_depth * height * width * 4 * 8 / (1024**3):.2f} GB of VRAM)")

    # Cópia obrigatória: os dois buffers se alternam a cada iteração, então sem
    # ela o array do CHAMADOR viraria o destino de escrita a partir da 2ª
    # (ascontiguousarray devolve o mesmo objeto se já for float32 contíguo).
    current = np.array(volume, dtype=np.float32)
    nxt = np.empty_like(current)

    for iteration in range(iterations):
        for z0 in range(0, depth, slab_depth):
            z1 = min(z0 + slab_depth, depth)

            # Halo de 1 voxel em Z vindo dos slabs vizinhos; na borda do volume
            # não há vizinho, então replica (mesma convenção do pad em Y/X).
            zlo = max(z0 - 1, 0)
            zhi = min(z1 + 1, depth)
            block = cp.asarray(current[zlo:zhi])

            pad_z = (1 if z0 == 0 else 0, 1 if z1 == depth else 0)
            padded = cp.pad(block, (pad_z, (1, 1), (1, 1)), mode='edge')
            del block

            center = padded[1:-1, 1:-1, 1:-1]

            # Acumula a divergência um vizinho por vez: manter os 6 gradientes e
            # os 6 coeficientes vivos ao mesmo tempo é o que estourava a VRAM.
            divergence = cp.zeros_like(center)
            neighbors = (
                padded[:-2, 1:-1, 1:-1],   # -Z
                padded[2:, 1:-1, 1:-1],    # +Z
                padded[1:-1, :-2, 1:-1],   # -Y
                padded[1:-1, 2:, 1:-1],    # +Y
                padded[1:-1, 1:-1, :-2],   # -X
                padded[1:-1, 1:-1, 2:],    # +X
            )
            for neighbor in neighbors:
                diff = neighbor - center
                grad = cp.abs(diff)
                if diffusion_type == 1:
                    # Exponential: favors high-contrast edges
                    coeff = cp.exp(-(grad / K) ** 2)
                else:
                    # Rational: favors wide regions
                    coeff = 1.0 / (1.0 + (grad / K) ** 2)
                divergence += coeff * diff
                del diff, grad, coeff

            # Update: I(t+1) = I(t) + lambda * divergence
            result = center + lambda_param * divergence
            nxt[z0:z1] = cp.asnumpy(result)

            del padded, center, divergence, result, neighbors
            cp.get_default_memory_pool().free_all_blocks()

        # O próximo passo lê o volume inteiro já atualizado — daí o buffer duplo
        current, nxt = nxt, current
        print(f"  Iteration {iteration + 1}/{iterations} complete")

    print("✓ Smoothing complete")
    return current


def compute_chunk_histograms(volume: np.ndarray, chunk_size: int, num_bins: int,
                             hist_min: float, hist_max: float) -> np.ndarray:
    """
    Compute a value histogram for each chunk in the volume.

    Unlike a simple min/max, per-chunk histograms allow empty space skipping
    with non-monotonic transfer functions: a chunk can be skipped if every
    occupied bin maps to zero opacity, even if the chunk's value range spans
    opaque regions of the transfer function.

    Each chunk's histogram covers the chunk PLUS a 1-voxel apron on every side
    (clamped at volume borders). Trilinear sampling near a chunk face
    interpolates voxels from the neighbouring chunk, so without the apron a
    chunk whose own voxels are all transparent could still produce visible
    samples at its border and be wrongly skipped. Consequence: bin counts
    overlap between neighbouring chunks and no longer sum to the volume's
    voxel count — they are an occupancy mask for skipping, not a partition.

    Partial chunks at the volume borders are NOT zero-padded: only real voxels
    are counted, so padding values (which would be meaningful in HU, e.g.
    0 = water) never pollute the histograms.

    Args:
        volume: 3D numpy array (Z, Y, X) with values in HU
        chunk_size: Size of each cubic chunk
        num_bins: Number of histogram bins
        hist_min: Lower edge of the histogram range (HU)
        hist_max: Upper edge of the histogram range (HU)

    Returns:
        Numpy array of shape (num_chunks_z, num_chunks_y, num_chunks_x, num_bins)
        with uint32 voxel counts per bin
    """
    depth, height, width = volume.shape

    num_chunks_z = (depth + chunk_size - 1) // chunk_size
    num_chunks_y = (height + chunk_size - 1) // chunk_size
    num_chunks_x = (width + chunk_size - 1) // chunk_size

    print(f"\nComputing chunk histograms...")
    print(f"  Chunk size: {chunk_size}³")
    print(f"  Bins per chunk: {num_bins}")
    print(f"  Histogram range: [{hist_min:.1f}, {hist_max:.1f}] HU")
    print(f"  Volume size: {width}×{height}×{depth}")
    print(f"  Number of chunks: {num_chunks_x}×{num_chunks_y}×{num_chunks_z} = {num_chunks_x * num_chunks_y * num_chunks_z}")

    # Allocate result array
    chunk_histograms = np.zeros((num_chunks_z, num_chunks_y, num_chunks_x, num_bins), dtype=np.uint32)

    total_chunks = num_chunks_x * num_chunks_y * num_chunks_z
    processed = 0

    # Precompute bin index for every voxel once, then count per chunk
    bin_width = (hist_max - hist_min) / num_bins
    if bin_width <= 0:
        # Degenerate volume (constant value): everything falls in bin 0
        bin_indices = np.zeros(volume.shape, dtype=np.int64)
    else:
        bin_indices = ((volume - hist_min) / bin_width).astype(np.int64)
        np.clip(bin_indices, 0, num_bins - 1, out=bin_indices)

    for iz in range(num_chunks_z):
        for iy in range(num_chunks_y):
            for ix in range(num_chunks_x):
                # 1-voxel apron on each side, clamped at the volume borders
                # (also handles partial border chunks: only real voxels)
                z_start = max(iz * chunk_size - 1, 0)
                y_start = max(iy * chunk_size - 1, 0)
                x_start = max(ix * chunk_size - 1, 0)

                z_end = min((iz + 1) * chunk_size + 1, depth)
                y_end = min((iy + 1) * chunk_size + 1, height)
                x_end = min((ix + 1) * chunk_size + 1, width)

                chunk_bins = bin_indices[z_start:z_end, y_start:y_end, x_start:x_end]
                counts = np.bincount(chunk_bins.ravel(), minlength=num_bins)
                chunk_histograms[iz, iy, ix] = counts.astype(np.uint32)

                processed += 1
                if processed % 100 == 0 or processed == total_chunks:
                    print(f"  Processed {processed}/{total_chunks} chunks", end='\r')

    print(f"\n✓ Chunk histogram computation complete")

    return chunk_histograms


def convert_dicom_series(input_dir: Path, output_dir: Path, apply_smoothing: bool = True,
                        smoothing_iterations: int = 5, smoothing_k: float = 50.0,
                        chunk_size: int = 32, histogram_bins: int = 32,
                        anonymize: bool = True, series_desc: str = None,
                        series_uid: str = None):
    """
    Convert DICOM series to float16 raw buffers and metadata JSON.

    Args:
        input_dir: Directory containing DICOM files
        output_dir: Directory to save output files
        apply_smoothing: Whether to apply Perona-Malik smoothing
        smoothing_iterations: Number of smoothing iterations
        smoothing_k: Perona-Malik edge threshold, in the units of the data
            (HU for CT, arbitrary scanner units for MR)
        chunk_size: Size of cubic chunks for histogram computation (must be multiple of 16)
        histogram_bins: Number of histogram bins per chunk
        anonymize: Whether to anonymize patient identifiers
        series_desc: Keep only this SeriesDescription (None = all series)
        series_uid: Keep only this SeriesInstanceUID (None = all series)
    """
    # Validate chunk size
    if chunk_size % 16 != 0:
        raise ValueError(f"Chunk size must be a multiple of 16, got {chunk_size}")
    if chunk_size < 16 or chunk_size > 256:
        raise ValueError(f"Chunk size must be between 16 and 256, got {chunk_size}")
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Read and sort DICOM files
    dicom_files = read_dicom_files(input_dir)
    if not dicom_files:
        print("✗ No valid DICOM files found!")
        return
    
    dicom_files = filter_series(dicom_files, series_desc, series_uid)
    series_files = select_largest_series(dicom_files)
    sorted_files = sort_dicom_slices(series_files)
    slice_spacing = derive_slice_spacing(sorted_files)
    
    # First pass - find GLOBAL min/max and load volume
    print("\nLoading volume into memory...")
    first_ds = sorted_files[0]
    height, width = first_ds.pixel_array.shape
    num_slices = len(sorted_files)
    
    # Allocate full volume
    volume = np.zeros((num_slices, height, width), dtype=np.float32)
    global_min = float('inf')
    global_max = float('-inf')
    
    for i, ds in enumerate(sorted_files):
        rescale_slope = float(getattr(ds, 'RescaleSlope', 1.0))
        rescale_intercept = float(getattr(ds, 'RescaleIntercept', 0.0))
        pixel_array = ds.pixel_array
        data = pixel_array.astype(np.float32) * rescale_slope + rescale_intercept
        
        slice_min = np.min(data)
        slice_max = np.max(data)
        
        global_min = min(global_min, slice_min)
        global_max = max(global_max, slice_max)
        
        volume[i] = data
        
        if (i + 1) % 50 == 0 or i == num_slices - 1:
            print(f"  Loaded {i + 1}/{num_slices} slices")
    
    print(f"  Global HU range: [{global_min:.1f}, {global_max:.1f}]")
    
    # Keep HU values as-is (no normalization)
    print("\nKeeping original HU values (no normalization)...")
    
    # Apply smoothing if requested
    if apply_smoothing and HAS_CUPY:
        volume = perona_malik_gpu(volume, iterations=smoothing_iterations,
                                  K=smoothing_k, lambda_param=0.1, diffusion_type=2)
    elif apply_smoothing and not HAS_CUPY:
        print("⚠  Smoothing requested but CuPy not available - saving unsmoothed volume")
    
    # Quantize to float16 BEFORE computing histograms. The renderer samples
    # the f16 data, and f16 rounding can move a voxel across a bin edge —
    # binning the f32 volume would make the skip test non-conservative.
    volume = volume.astype(np.float16).astype(np.float32)

    # Compute chunk histograms (after smoothing + quantization so they reflect
    # the values the shader will actually read). The bin range comes from the
    # final volume so no voxel falls outside it.
    hist_min = float(np.min(volume))
    hist_max = float(np.max(volume))
    chunk_histograms = compute_chunk_histograms(volume, chunk_size, histogram_bins,
                                                hist_min, hist_max)

    # Convert to float16 and save slices (lossless: already quantized above)
    print(f"\nSaving {num_slices} slices as float16...")
    volume_f16 = volume.astype(np.float16)
    
    for i in range(num_slices):
        output_file = output_dir / f"slice_{i:04d}.raw"
        volume_f16[i].tofile(str(output_file))
        
        if (i + 1) % 50 == 0 or i == num_slices - 1:
            print(f"  Saved {i + 1}/{num_slices} slices")
    
    # Save chunk histogram data as binary file
    chunk_file = output_dir / "chunk_histograms.bin"
    print(f"\nSaving chunk histogram data to: {chunk_file}")
    chunk_histograms.tofile(str(chunk_file))
    print(f"  Chunk data size: {chunk_histograms.nbytes / (1024*1024):.2f} MB")

    # Extract and save metadata
    print("\nExtracting metadata...")
    metadata = extract_metadata(sorted_files, global_min, global_max, slice_spacing, anonymize)

    # Add chunk information to metadata
    metadata["chunkSize"] = chunk_size
    metadata["numChunksX"] = int(chunk_histograms.shape[2])
    metadata["numChunksY"] = int(chunk_histograms.shape[1])
    metadata["numChunksZ"] = int(chunk_histograms.shape[0])
    metadata["totalChunks"] = int(chunk_histograms.shape[0] * chunk_histograms.shape[1] * chunk_histograms.shape[2])
    metadata["histogramBins"] = histogram_bins
    metadata["histogramMin"] = hist_min
    metadata["histogramMax"] = hist_max
    metadata["histogramDtype"] = "uint32"
    
    metadata_file = output_dir / "metadata.json"
    print(f"Saving metadata to: {metadata_file}")
    
    with open(metadata_file, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    
    print("\n✅ Conversion complete!")
    print(f"   Output directory: {output_dir}")
    print(f"   Slice files: slice_0000.raw to slice_{num_slices-1:04d}.raw")
    print(f"   Chunk data: chunk_histograms.bin")
    print(f"   Metadata: metadata.json")
    print(f"   Volume dimensions: {width}x{height}x{num_slices}")
    print(f"   Slice spacing: {slice_spacing:.4f} mm")
    print(f"   Chunk configuration: {chunk_size}³ chunks, {histogram_bins} bins each")
    print(f"   Total chunks: {metadata['numChunksX']}×{metadata['numChunksY']}×{metadata['numChunksZ']} = {metadata['totalChunks']}")
    print(f"   HU range: [{metadata['huMin']:.1f}, {metadata['huMax']:.1f}]")
    print(f"   Anonymization: {'Enabled' if anonymize else 'Disabled'}")
    if apply_smoothing and HAS_CUPY:
        print(f"   Smoothing: Applied ({smoothing_iterations} iterations, K={smoothing_k:g})")
    else:
        print(f"   Smoothing: Skipped")
    

def main():
    parser = argparse.ArgumentParser(
        description='Convert DICOM series to float16 raw buffers for WebGPU',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python dicom_converter.py -i ./dicom_data -o ./output
  python dicom_converter.py -i ./dicom_data -o ./output --no-smooth
  python dicom_converter.py -i ./dicom_data -o ./output --iterations 10
  python dicom_converter.py -i ./dicom_data -o ./output --no-anonymize
  python dicom_converter.py -i ./dicom_data -o ./output --chunk-size 64 --no-smooth
  python dicom_converter.py -i ./dicom_data -o ./output --histogram-bins 64
  python dicom_converter.py -i ./study --list-series
  python dicom_converter.py -i ./study -o ./output --series "ARTERIAL TOF SJ"
  python dicom_converter.py -i ./study -o ./output --series-uid 1.2.840.113619.2
  python dicom_converter.py -i ./mri -o ./output --smooth-k 15   # MR, not HU
        """
    )
    
    parser.add_argument(
        '-i', '--input',
        type=str,
        required=True,
        help='Input directory containing DICOM files'
    )
    
    parser.add_argument(
        '-o', '--output',
        type=str,
        help='Output directory for raw buffers and metadata (not needed with --list-series)'
    )

    parser.add_argument(
        '--list-series',
        action='store_true',
        help='List the series found in the input directory and exit'
    )

    parser.add_argument(
        '--series',
        type=str,
        default=None,
        help='Convert only the series with this SeriesDescription (case-insensitive)'
    )

    parser.add_argument(
        '--series-uid',
        type=str,
        default=None,
        help='Convert only the series with this SeriesInstanceUID (unambiguous)'
    )
    
    parser.add_argument(
        '--no-smooth',
        action='store_true',
        help='Skip Perona-Malik smoothing (faster, less memory)'
    )
    
    parser.add_argument(
        '--iterations',
        type=int,
        default=5,
        help='Number of smoothing iterations (default: 5)'
    )
    
    parser.add_argument(
        '--smooth-k',
        type=float,
        default=50.0,
        help='Perona-Malik edge threshold, in the units of the data (default: 50, '
             'tuned for CT Hounsfield units - MR needs a much smaller value)'
    )

    parser.add_argument(
        '--chunk-size',
        type=int,
        default=32,
        help='Size of cubic chunks for histogram computation (must be multiple of 16, default: 32)'
    )

    parser.add_argument(
        '--histogram-bins',
        type=int,
        default=32,
        help='Number of histogram bins per chunk (default: 32)'
    )
    
    parser.add_argument(
        '--no-anonymize',
        action='store_true',
        help='Do not anonymize patient identifiers (keep original names/IDs)'
    )
    
    args = parser.parse_args()

    input_dir = Path(args.input)

    if not args.list_series and not args.output:
        print("✗ Error: -o/--output is required (unless --list-series)")
        sys.exit(1)

    output_dir = Path(args.output) if args.output else None
        
    # Validate chunk size
    if args.chunk_size % 16 != 0:
        print(f"✗ Error: Chunk size must be a multiple of 16, got {args.chunk_size}")
        sys.exit(1)
    
    if args.chunk_size < 16 or args.chunk_size > 256:
        print(f"✗ Error: Chunk size must be between 16 and 256, got {args.chunk_size}")
        sys.exit(1)

    if args.histogram_bins < 2 or args.histogram_bins > 1024:
        print(f"✗ Error: Histogram bins must be between 2 and 1024, got {args.histogram_bins}")
        sys.exit(1)
    
    # Validate input directory
    if not input_dir.exists():
        print(f"✗ Error: Input directory does not exist: {input_dir}")
        sys.exit(1)
    
    if not input_dir.is_dir():
        print(f"✗ Error: Input path is not a directory: {input_dir}")
        sys.exit(1)

    # Inventory mode: read the headers, print what is in there, and stop.
    if args.list_series:
        dicom_files = read_dicom_files(input_dir)
        if not dicom_files:
            print("✗ No valid DICOM files found!")
            sys.exit(1)
        print("\nSeries found:")
        print(describe_series(group_series(dicom_files)))
        sys.exit(0)
        
    # Warn if not anonymizing
    anonymize = not args.no_anonymize
    if not anonymize:
        print("\n" + "="*60)
        print("⚠  WARNING: Patient data will NOT be anonymized!")
        print("="*60)
        response = input("Continue without anonymization? (yes/no): ")
        if response.lower() not in ['yes', 'y']:
            print("Conversion cancelled.")
            sys.exit(0)
        print()
    
    print("="*60)
    print("DICOM to Float16 Converter with GPU Smoothing")
    print("="*60)
    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")
    if args.series:
        print(f"Series: '{args.series}'")
    if args.series_uid:
        print(f"Series UID: {args.series_uid}")
    print(f"Chunk size: {args.chunk_size}³")
    print(f"Histogram bins: {args.histogram_bins}")
    print(f"Smoothing: {'Disabled' if args.no_smooth else f'Enabled ({args.iterations} iterations, K={args.smooth_k:g})'}")
    print(f"Anonymization: {'Enabled' if anonymize else 'Disabled'}")
    print("="*60 + "\n")
    
    try:
        convert_dicom_series(input_dir, output_dir,
                           apply_smoothing=not args.no_smooth,
                           smoothing_iterations=args.iterations,
                           smoothing_k=args.smooth_k,
                           chunk_size=args.chunk_size,
                           histogram_bins=args.histogram_bins,
                           anonymize=anonymize,
                           series_desc=args.series,
                           series_uid=args.series_uid)
    except Exception as e:
        print(f"\n✗ Error during conversion: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()