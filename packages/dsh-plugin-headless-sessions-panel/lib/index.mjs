// Compatibility shim: older compositions resolved this package through
// `package.json#main`, which used to be this file. The implementation now lives
// in ./host.mjs; this re-export keeps that specifier working without duplicating
// the code.
export { default } from './host.mjs'
export * from './host.mjs'
