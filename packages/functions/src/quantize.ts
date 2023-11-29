import {
	Accessor,
	AnimationChannel,
	bbox,
	Document,
	ILogger,
	mat4,
	MathUtils,
	Mesh,
	Node,
	Primitive,
	PrimitiveTarget,
	Property,
	Skin,
	Transform,
	vec2,
	vec3,
	vec4,
} from '@gltf-transform/core';
import { fromRotationTranslationScale, fromScaling, invert, multiply as multiplyMat4 } from 'gl-matrix/mat4';
import { max, min, scale, transformMat4 } from 'gl-matrix/vec3';
import { InstancedMesh, KHRMeshQuantization } from '@gltf-transform/extensions';
import type { Volume } from '@gltf-transform/extensions';
import { createTransform } from './utils.js';
import { sortPrimitiveWeights } from './sort-primitive-weights.js';

const NAME = 'quantize';

type TypedArrayConstructor =
	| Int8ArrayConstructor
	| Int16ArrayConstructor
	| Uint8ArrayConstructor
	| Uint16ArrayConstructor;
const SIGNED_INT = [Int8Array, Int16Array, Int32Array] as TypedArrayConstructor[];

const { TRANSLATION, ROTATION, SCALE, WEIGHTS } = AnimationChannel.TargetPath;
const TRS_CHANNELS = [TRANSLATION, ROTATION, SCALE];

/** Options for the {@link quantize} function. */
export interface QuantizeOptions {
	/** Pattern (regex) used to filter vertex attribute semantics for quantization. Default: all. */
	pattern?: RegExp;
	/** Pattern (regex) used to filter morph target semantics for quantization. Default: `options.pattern`. */
	patternTargets?: RegExp;
	/** Bounds for quantization grid. */
	quantizationVolume?: 'mesh' | 'scene';
	/** Quantization bits for `POSITION` attributes. */
	quantizePosition?: number;
	/** Quantization bits for `NORMAL` attributes. */
	quantizeNormal?: number;
	/** Quantization bits for `TEXCOORD_*` attributes. */
	quantizeTexcoord?: number;
	/** Quantization bits for `COLOR_*` attributes. */
	quantizeColor?: number;
	/** Quantization bits for `WEIGHT_*` attributes. */
	quantizeWeight?: number;
	/** Quantization bits for application-specific (`_*`) attributes. */
	quantizeGeneric?: number;
	/** Normalize weight attributes. */
	normalizeWeights?: boolean;
}

export const QUANTIZE_DEFAULTS: Required<Omit<QuantizeOptions, 'patternTargets'>> = {
	pattern: /.*/,
	quantizationVolume: 'mesh',
	quantizePosition: 14,
	quantizeNormal: 10,
	quantizeTexcoord: 12,
	quantizeColor: 8,
	quantizeWeight: 8,
	quantizeGeneric: 12,
	normalizeWeights: true,
};

/**
 * References:
 * - https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization
 * - http://www.aclockworkberry.com/normal-unpacking-quantization-errors/
 * - https://www.mathworks.com/help/dsp/ref/uniformencoder.html
 * - https://oroboro.com/compressed-unit-vectors/
 */

/**
 * Quantizes vertex attributes with `KHR_mesh_quantization`, reducing the size and memory footprint
 * of the file.
 *
 * @category Transforms
 */
export function quantize(_options: QuantizeOptions = QUANTIZE_DEFAULTS): Transform {
	const options = { ...QUANTIZE_DEFAULTS, ..._options } as Required<QuantizeOptions>;

	options.patternTargets = options.patternTargets || options.pattern;

	return createTransform(NAME, async (doc: Document): Promise<void> => {
		const logger = doc.getLogger();
		const root = doc.getRoot();

		const context: QuantizeContext = { touched: new Set() };

		doc.createExtension(KHRMeshQuantization).setRequired(true);

		// Compute vertex position quantization volume.
		let nodeTransform: VectorTransform<vec3> | undefined = undefined;
		if (options.quantizationVolume === 'scene') {
			nodeTransform = getNodeTransform(expandBounds(root.listMeshes().map(getPositionQuantizationVolume)));
		}

		// Quantize mesh primitives.
		for (const mesh of doc.getRoot().listMeshes()) {
			if (options.quantizationVolume === 'mesh') {
				nodeTransform = getNodeTransform(getPositionQuantizationVolume(mesh));
			}

			if (nodeTransform && options.pattern.test('POSITION')) {
				transformMeshParents(doc, mesh, nodeTransform, context);
				transformMeshMaterials(mesh, 1 / nodeTransform.scale, context);
			}

			for (const prim of mesh.listPrimitives()) {
				quantizePrimitive(doc, prim, nodeTransform!, options, context);
				for (const target of prim.listTargets()) {
					quantizePrimitive(doc, target, nodeTransform!, options, context);
				}
			}
		}

		const touchedByType: Record<string, Property[]> = {};

		// prune
		for (const property of context.touched) {
			if (property.listParents().some((parent) => parent !== root)) {
				touchedByType[property.propertyType] = touchedByType[property.propertyType] || [];
				touchedByType[property.propertyType].push(property);
			} else {
				property.dispose();
			}
		}

		// dedup
		for (const propertyType in touchedByType) {
			for (const property in touchedByType[propertyType]) {
				// TODO: Deduplicate touched properties. The dedup() implementation is not easily
				// repurposed for this, but could probably be cleaned up a lot now that .equals()
				// is available.
			}
		}

		// await doc.transform(
		// 	prune({
		// 		propertyTypes: [PropertyType.ACCESSOR, PropertyType.SKIN, PropertyType.MATERIAL],
		// 		keepAttributes: true,
		// 		keepIndices: true,
		// 	}),
		// 	dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MATERIAL, PropertyType.SKIN] }),
		// );

		logger.debug(`${NAME}: Complete.`);
	});
}

function quantizePrimitive(
	doc: Document,
	prim: Primitive | PrimitiveTarget,
	nodeTransform: VectorTransform<vec3>,
	options: Required<QuantizeOptions>,
	context: QuantizeContext,
): void {
	const isTarget = prim instanceof PrimitiveTarget;
	const logger = doc.getLogger();

	for (const semantic of prim.listSemantics()) {
		if (!isTarget && !options.pattern.test(semantic)) continue;
		if (isTarget && !options.patternTargets.test(semantic)) continue;

		const srcAttribute = prim.getAttribute(semantic)!;

		const { bits, ctor } = getQuantizationSettings(semantic, srcAttribute, logger, options);

		if (!ctor) continue;
		if (bits < 8 || bits > 16) throw new Error(`${NAME}: Requires bits = 8–16.`);
		if (srcAttribute.getComponentSize() <= bits / 8) continue;

		const dstAttribute = srcAttribute.clone();

		// Remap position data.
		if (semantic === 'POSITION') {
			const scale = nodeTransform.scale;
			const transform: mat4 = [] as unknown as mat4;
			// Morph targets are relative offsets, don't translate them.
			prim instanceof Primitive
				? invert(transform, fromTransform(nodeTransform))
				: fromScaling(transform, [1 / scale, 1 / scale, 1 / scale]);
			for (let i = 0, el: vec3 = [0, 0, 0], il = dstAttribute.getCount(); i < il; i++) {
				dstAttribute.getElement(i, el);
				dstAttribute.setElement(i, transformMat4(el, el, transform) as vec3);
			}
		}

		// Quantize the vertex attribute.
		quantizeAttribute(dstAttribute, ctor, bits);
		prim.swap(srcAttribute, dstAttribute);

		context.touched.add(srcAttribute);
		context.touched.add(dstAttribute);
	}

	// Normalize skinning weights.
	if (options.normalizeWeights && prim.getAttribute('WEIGHTS_0')) {
		sortPrimitiveWeights(prim, Infinity);
	}

	if (
		prim instanceof Primitive &&
		prim.getIndices() &&
		prim.listAttributes().length &&
		prim.listAttributes()[0]!.getCount() < 65535
	) {
		const indices = prim.getIndices()!;
		indices.setArray(new Uint16Array(indices.getArray()!));
	}
}

/** Computes node quantization transforms in local space. */
function getNodeTransform(volume: bbox): VectorTransform<vec3> {
	const { min, max } = volume;

	// Scaling factor transforms [-1,1] box to the mesh AABB in local space.
	// See: https://github.com/donmccurdy/glTF-Transform/issues/328
	const scale = Math.max(
		(max[0] - min[0]) / 2, // Divide because interval [-1,1] has length 2.
		(max[1] - min[1]) / 2,
		(max[2] - min[2]) / 2,
	);

	// Original center of the mesh, in local space.
	const offset: vec3 = [
		min[0] + (max[0] - min[0]) / 2,
		min[1] + (max[1] - min[1]) / 2,
		min[2] + (max[2] - min[2]) / 2,
	];

	return { offset, scale };
}

/** Applies corrective scale and offset to nodes referencing a quantized Mesh. */
function transformMeshParents(
	doc: Document,
	mesh: Mesh,
	nodeTransform: VectorTransform<vec3>,
	context: QuantizeContext,
): void {
	const transformMatrix = fromTransform(nodeTransform);
	for (const parent of mesh.listParents()) {
		if (!(parent instanceof Node)) continue;

		const animChannels = parent.listParents().filter((p) => p instanceof AnimationChannel) as AnimationChannel[];
		const isAnimated = animChannels.some((channel) => TRS_CHANNELS.includes(channel.getTargetPath()!));
		const isParentNode = parent.listChildren().length > 0;

		const skin = parent.getSkin();
		if (skin) {
			parent.setSkin(transformSkin(skin, nodeTransform, context));
			continue;
		}

		const batch = parent.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
		if (batch) {
			parent.setExtension('EXT_mesh_gpu_instancing', transformBatch(batch, nodeTransform, context));
			continue;
		}

		let targetNode: Node;
		if (isParentNode || isAnimated) {
			targetNode = doc.createNode('').setMesh(mesh);
			parent.addChild(targetNode).setMesh(null);
			animChannels
				.filter((channel) => channel.getTargetPath() === WEIGHTS)
				.forEach((channel) => channel.setTargetNode(targetNode));
		} else {
			targetNode = parent;
		}

		const nodeMatrix = targetNode.getMatrix();
		multiplyMat4(nodeMatrix, nodeMatrix, transformMatrix);
		targetNode.setMatrix(nodeMatrix);
	}
}

/** Applies corrective scale and offset to skin IBMs. */
function transformSkin(srcSkin: Skin, nodeTransform: VectorTransform<vec3>, context: QuantizeContext): Skin {
	const dstSkin = srcSkin.clone();

	const transformMatrix = fromTransform(nodeTransform);
	const srcInverseBindMatrices = dstSkin.getInverseBindMatrices()!;
	const dstInverseBindMatrices = srcInverseBindMatrices.clone();
	const ibm = [] as unknown as mat4;
	for (let i = 0, count = dstInverseBindMatrices.getCount(); i < count; i++) {
		dstInverseBindMatrices.getElement(i, ibm);
		multiplyMat4(ibm, ibm, transformMatrix);
		dstInverseBindMatrices.setElement(i, ibm);
	}

	context.touched.add(srcSkin);
	context.touched.add(dstSkin);

	context.touched.add(srcInverseBindMatrices);
	context.touched.add(dstInverseBindMatrices);

	return dstSkin.setInverseBindMatrices(dstInverseBindMatrices);
}

/** Applies corrective scale and offset to GPU instancing batches. */
function transformBatch(
	srcBatch: InstancedMesh,
	nodeTransform: VectorTransform<vec3>,
	context: QuantizeContext,
): InstancedMesh {
	const srcTranslation = srcBatch.getAttribute('TRANSLATION');
	const srcRotation = srcBatch.getAttribute('ROTATION');
	const srcScale = srcBatch.getAttribute('SCALE');

	if (!srcTranslation && !srcRotation && !srcScale) {
		return srcBatch;
	}

	const dstBatch = srcBatch.clone();
	const dstTranslation = srcTranslation?.clone();
	const dstRotation = srcRotation?.clone();
	const dstScale = srcScale?.clone();
	const tpl = (dstTranslation || dstRotation || dstScale)!;

	const T_IDENTITY = [0, 0, 0] as vec3;
	const R_IDENTITY = [0, 0, 0, 1] as vec4;
	const S_IDENTITY = [1, 1, 1] as vec3;

	const t = [0, 0, 0] as vec3;
	const r = [0, 0, 0, 1] as vec4;
	const s = [1, 1, 1] as vec3;

	// prettier-ignore
	const instanceMatrix = [
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		0, 0, 0, 1,
	] as mat4;

	const transformMatrix = fromTransform(nodeTransform);

	for (let i = 0, count = tpl.getCount(); i < count; i++) {
		MathUtils.compose(
			dstTranslation ? (dstTranslation.getElement(i, t) as vec3) : T_IDENTITY,
			dstRotation ? (dstRotation.getElement(i, r) as vec4) : R_IDENTITY,
			dstScale ? (dstScale.getElement(i, s) as vec3) : S_IDENTITY,
			instanceMatrix,
		);

		multiplyMat4(instanceMatrix, instanceMatrix, transformMatrix);

		MathUtils.decompose(instanceMatrix, t, r, s);

		if (dstTranslation) dstTranslation.setElement(i, t);
		if (dstRotation) dstRotation.setElement(i, r);
		if (dstScale) dstScale.setElement(i, s);
	}

	if (dstTranslation) dstBatch.setAttribute('TRANSLATION', dstTranslation);
	if (dstRotation) dstBatch.setAttribute('ROTATION', dstRotation);
	if (dstScale) dstBatch.setAttribute('SCALE', dstScale);

	context.touched.add(srcBatch);
	context.touched.add(dstBatch);

	for (const property of [srcTranslation, srcRotation, srcScale, dstTranslation, dstRotation, dstScale]) {
		if (!property) continue;
		context.touched.add(property);
	}

	return dstBatch;
}

/** Applies corrective scale to volumetric materials, which give thickness in local units. */
function transformMeshMaterials(mesh: Mesh, scale: number, context: QuantizeContext) {
	for (const prim of mesh.listPrimitives()) {
		const srcMaterial = prim.getMaterial();
		if (!srcMaterial) continue;

		const srcVolume = srcMaterial.getExtension<Volume>('KHR_materials_volume');
		if (!srcVolume || srcVolume.getThicknessFactor() <= 0) continue;

		const dstVolume = srcVolume.clone().setThicknessFactor(srcVolume.getThicknessFactor() * scale);
		const dstMaterial = srcMaterial.clone().setExtension('KHR_materials_volume', dstVolume);
		prim.setMaterial(dstMaterial);

		context.touched.add(srcMaterial);
		context.touched.add(dstMaterial);

		context.touched.add(srcVolume);
		context.touched.add(dstVolume);
	}
}

/**
 * Quantizes an attribute to the given parameters.
 *
 * Uniformly remap 32-bit floats to reduced-precision 8- or 16-bit integers, so
 * that there are only 2^N unique values, for N within [8, 16].
 *
 * See: https://github.com/donmccurdy/glTF-Transform/issues/208
 */
function quantizeAttribute(attribute: Accessor, ctor: TypedArrayConstructor, bits: number): void {
	const dstArray = new ctor(attribute.getArray()!.length);

	const signBits = SIGNED_INT.includes(ctor) ? 1 : 0;
	const quantBits = bits - signBits;
	const storageBits = ctor.BYTES_PER_ELEMENT * 8 - signBits;

	const scale = Math.pow(2, quantBits) - 1;
	const lo = storageBits - quantBits;
	const hi = 2 * quantBits - storageBits;
	const range = [signBits > 0 ? -1 : 0, 1] as vec2;

	for (let i = 0, di = 0, el: number[] = []; i < attribute.getCount(); i++) {
		attribute.getElement(i, el);
		for (let j = 0; j < el.length; j++) {
			// Clamp to range.
			let value = clamp(el[j], range);

			// Map [0.0 ... 1.0] to [0 ... scale].
			value = Math.round(Math.abs(value) * scale);

			// Replicate msb to missing lsb.
			value = (value << lo) | (value >> hi);

			// Restore sign.
			dstArray[di++] = value * Math.sign(el[j]);
		}
	}

	// TODO(feat): Support sparse accessors, https://github.com/donmccurdy/glTF-Transform/issues/795
	attribute.setArray(dstArray).setNormalized(true).setSparse(false);
}

function getQuantizationSettings(
	semantic: string,
	attribute: Accessor,
	logger: ILogger,
	options: Required<QuantizeOptions>,
): { bits: number; ctor?: TypedArrayConstructor } {
	const min = attribute.getMinNormalized([]);
	const max = attribute.getMaxNormalized([]);

	let bits: number;
	let ctor: TypedArrayConstructor;

	if (semantic === 'POSITION') {
		bits = options.quantizePosition;
		ctor = bits <= 8 ? Int8Array : Int16Array;
	} else if (semantic === 'NORMAL' || semantic === 'TANGENT') {
		bits = options.quantizeNormal;
		ctor = bits <= 8 ? Int8Array : Int16Array;
	} else if (semantic.startsWith('COLOR_')) {
		bits = options.quantizeColor;
		ctor = bits <= 8 ? Uint8Array : Uint16Array;
	} else if (semantic.startsWith('TEXCOORD_')) {
		if (min.some((v) => v < 0) || max.some((v) => v > 1)) {
			logger.warn(`${NAME}: Skipping ${semantic}; out of [0,1] range.`);
			return { bits: -1 };
		}
		bits = options.quantizeTexcoord;
		ctor = bits <= 8 ? Uint8Array : Uint16Array;
	} else if (semantic.startsWith('JOINTS_')) {
		bits = Math.max(...attribute.getMax([])) <= 255 ? 8 : 16;
		ctor = bits <= 8 ? Uint8Array : Uint16Array;
		if (attribute.getComponentSize() > bits / 8) {
			attribute.setArray(new ctor(attribute.getArray()!));
		}
		return { bits: -1 };
	} else if (semantic.startsWith('WEIGHTS_')) {
		if (min.some((v) => v < 0) || max.some((v) => v > 1)) {
			logger.warn(`${NAME}: Skipping ${semantic}; out of [0,1] range.`);
			return { bits: -1 };
		}
		bits = options.quantizeWeight;
		ctor = bits <= 8 ? Uint8Array : Uint16Array;
	} else if (semantic.startsWith('_')) {
		if (min.some((v) => v < -1) || max.some((v) => v > 1)) {
			logger.warn(`${NAME}: Skipping ${semantic}; out of [-1,1] range.`);
			return { bits: -1 };
		}
		bits = options.quantizeGeneric;
		ctor = min.some((v) => v < 0)
			? (ctor = bits <= 8 ? Int8Array : Int16Array)
			: (ctor = bits <= 8 ? Uint8Array : Uint16Array);
	} else {
		throw new Error(`${NAME}: Unexpected semantic, "${semantic}".`);
	}

	return { bits, ctor };
}

function getPositionQuantizationVolume(mesh: Mesh): bbox {
	const positions: Accessor[] = [];
	const relativePositions: Accessor[] = [];
	for (const prim of mesh.listPrimitives()) {
		const attribute = prim.getAttribute('POSITION');
		if (attribute) positions.push(attribute);
		for (const target of prim.listTargets()) {
			const attribute = target.getAttribute('POSITION');
			if (attribute) relativePositions.push(attribute);
		}
	}

	if (positions.length === 0) {
		throw new Error(`${NAME}: Missing "POSITION" attribute.`);
	}

	const bbox = flatBounds<vec3>(positions, 3);

	// Morph target quantization volume is computed differently. First, ensure that the origin
	// <0, 0, 0> is in the quantization volume. Because we can't offset target positions (they're
	// relative deltas), default remapping will only map to a [-2, 2] AABB. Double the bounding box
	// to ensure scaling puts them within a [-1, 1] AABB instead.
	if (relativePositions.length > 0) {
		const { min: relMin, max: relMax } = flatBounds<vec3>(relativePositions, 3);
		min(bbox.min, bbox.min, min(relMin, scale(relMin, relMin, 2), [0, 0, 0]));
		max(bbox.max, bbox.max, max(relMax, scale(relMax, relMax, 2), [0, 0, 0]));
	}

	return bbox;
}

/** Computes total min and max of all Accessors in a list. */
function flatBounds<T = vec2 | vec3>(accessors: Accessor[], elementSize: number): { min: T; max: T } {
	const min: number[] = new Array(elementSize).fill(Infinity);
	const max: number[] = new Array(elementSize).fill(-Infinity);

	const tmpMin: number[] = [];
	const tmpMax: number[] = [];

	for (const accessor of accessors) {
		accessor.getMinNormalized(tmpMin);
		accessor.getMaxNormalized(tmpMax);
		for (let i = 0; i < elementSize; i++) {
			min[i] = Math.min(min[i], tmpMin[i]);
			max[i] = Math.max(max[i], tmpMax[i]);
		}
	}

	return { min, max } as unknown as { min: T; max: T };
}

function expandBounds(bboxes: bbox[]): bbox {
	const result = bboxes[0];
	for (const bbox of bboxes) {
		min(result.min, result.min, bbox.min);
		max(result.max, result.max, bbox.max);
	}
	return result;
}

interface VectorTransform<T = vec2 | vec3 | vec4> {
	offset: T;
	scale: number;
}

function fromTransform(transform: VectorTransform<vec3>): mat4 {
	return fromRotationTranslationScale([] as unknown as mat4, [0, 0, 0, 1], transform.offset, [
		transform.scale,
		transform.scale,
		transform.scale,
	]) as mat4;
}

function clamp(value: number, range: vec2): number {
	return Math.min(Math.max(value, range[0]), range[1]);
}

interface QuantizeContext {
	touched: Set<Property>;
}
