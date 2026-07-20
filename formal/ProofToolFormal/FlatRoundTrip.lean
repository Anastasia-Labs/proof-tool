import Lean
import PlutusCore.UPLC
import ProofToolFormal.Artifacts

/-!
A small Flat encoder used only to close the exact-import provenance loop.

PlutusCoreBlaster currently ships a decoder but no encoder. This module
implements the inverse subset needed by serializable UPLC programs, re-encodes
the imported AST, wraps it in canonical definite-length CBOR, and compares it
with the locked exporter file. Unsupported or type-ambiguous constants return
`none`.
-/

namespace ProofToolFormal.FlatRoundTrip

open PlutusCore.UPLC.Term

abbrev EncoderM := StateT (Array Bool) Option

def failM : EncoderM α := fun _ => none

def ensureM (condition : Bool) : EncoderM Unit :=
  if condition then pure () else failM

def emitBits (bits : List Bool) : EncoderM Unit := fun state =>
  some ((), bits.foldl (fun acc bit => acc.push bit) state)

def fixedNatBits (width value : Nat) : Option (List Bool) :=
  if value < 2 ^ width then
    some <| (List.range width).map fun index =>
      ((value / 2 ^ (width - index - 1)) % 2) == 1
  else
    none

def encodeFixedNat (width value : Nat) : EncoderM Unit := do
  let bits ← fixedNatBits width value
  emitBits bits

partial def encodeNat (value : Nat) : EncoderM Unit := do
  if value < 128 then
    emitBits [false]
    encodeFixedNat 7 value
  else
    emitBits [true]
    encodeFixedNat 7 (value % 128)
    encodeNat (value / 128)

def zigZag (value : Int) : Nat :=
  if 0 ≤ value then
    2 * value.toNat
  else
    (-2 * value - 1).toNat

def encodeInt (value : Int) : EncoderM Unit :=
  encodeNat (zigZag value)

partial def encodeList (encode : α → EncoderM Unit) : List α → EncoderM Unit
  | [] => emitBits [false]
  | item :: remaining => do
      emitBits [true]
      encode item
      encodeList encode remaining

def emitPadding : EncoderM Unit := do
  let state ← get
  let count := 8 - state.size % 8
  emitBits (List.replicate (count - 1) false ++ [true])

def emitChar (char : Char) : EncoderM Unit :=
  encodeFixedNat 8 char.toNat

partial def encodeChunks : List Char → EncoderM Unit
  | [] => encodeFixedNat 8 0
  | bytes => do
      let chunk := bytes.take 255
      encodeFixedNat 8 chunk.length
      for byte in chunk do
        emitChar byte
      encodeChunks (bytes.drop 255)

def encodeByteString (bytes : String) : EncoderM Unit := do
  emitPadding
  encodeChunks bytes.data

mutual
  partial def builtinTypeEq : BuiltinType → BuiltinType → Bool
    | .AtomicType left, .AtomicType right => left == right
    | .TypeOperator left, .TypeOperator right => typeOperatorEq left right
    | _, _ => false

  partial def typeOperatorEq : TypeOperator → TypeOperator → Bool
    | .TypeList left, .TypeList right => builtinTypeEq left right
    | .TypePair leftA leftB, .TypePair rightA rightB =>
        builtinTypeEq leftA rightA && builtinTypeEq leftB rightB
    | _, _ => false
end

mutual
  partial def inferConstType : Const → Option BuiltinType
    | .Integer _ => some (.AtomicType .TypeInteger)
    | .ByteString _ => some (.AtomicType .TypeByteString)
    | .String _ => some (.AtomicType .TypeString)
    | .Unit => some (.AtomicType .TypeUnit)
    | .Bool _ => some (.AtomicType .TypeBool)
    | .ConstList [] => none
    | .ConstList (head :: tail) => do
        let elementType ← inferConstType head
        if tail.all (fun constant =>
            match inferConstType constant with
            | some actual => builtinTypeEq elementType actual
            | none => false) then
          some (.TypeOperator (.TypeList elementType))
        else none
    | .ConstDataList _ =>
        some (.TypeOperator (.TypeList (.AtomicType .TypeData)))
    | .ConstPairDataList _ =>
        some (.TypeOperator (.TypeList
          (.TypeOperator (.TypePair
            (.AtomicType .TypeData) (.AtomicType .TypeData)))))
    | .Pair (left, right) => do
        let leftType ← inferConstType left
        let rightType ← inferConstType right
        some (.TypeOperator (.TypePair leftType rightType))
    | .PairData _ =>
        some (.TypeOperator (.TypePair
          (.AtomicType .TypeData) (.AtomicType .TypeData)))
    | .Data _ => some (.AtomicType .TypeData)
    | .Bls12_381_G1_element _
    | .Bls12_381_G2_element _
    | .Bls12_381_MlResult _ => none

  partial def constTypeTags : BuiltinType → Option (List Nat)
    | .AtomicType .TypeInteger => some [0]
    | .AtomicType .TypeByteString => some [1]
    | .AtomicType .TypeString => some [2]
    | .AtomicType .TypeUnit => some [3]
    | .AtomicType .TypeBool => some [4]
    | .AtomicType .TypeData => some [8]
    | .AtomicType .TypeBls12_381_G1_element
    | .AtomicType .TypeBls12_381_G2_element
    | .AtomicType .TypeBls12_381_MlResult => none
    | .TypeOperator (.TypeList element) => do
        let tags ← constTypeTags element
        some ([7, 5] ++ tags)
    | .TypeOperator (.TypePair left right) => do
        let leftTags ← constTypeTags left
        let rightTags ← constTypeTags right
        some ([7, 7, 6] ++ leftTags ++ rightTags)

  partial def encodeConstValue : BuiltinType → Const → EncoderM Unit
    | .AtomicType .TypeInteger, .Integer value => encodeInt value
    | .AtomicType .TypeByteString, .ByteString value =>
        encodeByteString value.data
    | .AtomicType .TypeString, .String value =>
        encodeByteString (PlutusCore.String.encodeUtf8 value).data
    | .AtomicType .TypeUnit, .Unit => pure ()
    | .AtomicType .TypeBool, .Bool value => emitBits [value]
    | .AtomicType .TypeData, .Data value => do
        let encoded ← PlutusCore.Cbor.encodeData value
        encodeByteString encoded
    | .TypeOperator (.TypeList element), .ConstList values =>
        encodeList (encodeConstValue element) values
    | .TypeOperator (.TypeList (.AtomicType .TypeData)),
        .ConstDataList values =>
        encodeList (fun value => do
          let encoded ← PlutusCore.Cbor.encodeData value
          encodeByteString encoded) values
    | .TypeOperator (.TypeList
          (.TypeOperator (.TypePair
            (.AtomicType .TypeData) (.AtomicType .TypeData)))),
        .ConstPairDataList values =>
        encodeList (fun (left, right) => do
          let encodedLeft ← PlutusCore.Cbor.encodeData left
          encodeByteString encodedLeft
          let encodedRight ← PlutusCore.Cbor.encodeData right
          encodeByteString encodedRight) values
    | .TypeOperator (.TypePair leftType rightType), .Pair (left, right) => do
        encodeConstValue leftType left
        encodeConstValue rightType right
    | .TypeOperator (.TypePair
          (.AtomicType .TypeData) (.AtomicType .TypeData)),
        .PairData (left, right) => do
        let encodedLeft ← PlutusCore.Cbor.encodeData left
        encodeByteString encodedLeft
        let encodedRight ← PlutusCore.Cbor.encodeData right
        encodeByteString encodedRight
    | _, _ => failM
end

def encodeConst (constant : Const) : EncoderM Unit := do
  let constantType ← inferConstType constant
  let tags ← constTypeTags constantType
  encodeList (encodeFixedNat 4) tags
  encodeConstValue constantType constant

def builtinIndex (builtin : BuiltinFun) : Option Nat :=
  (PlutusCore.UPLC.FlatEncoding.Internal.builtinTable.find?
    (fun entry => entry.2 == builtin)).map Prod.fst

def deBruijnIndex (next : Nat) (name : String) : Option Nat := do
  let suffix ←
    match name.data with
    | 'd' :: 'b' :: 'i' :: '_' :: digits => some (String.mk digits)
    | _ => none
  let boundIndex ← suffix.toNat?
  if boundIndex < next then some (next - boundIndex) else none

partial def encodeTerm (version : Version) (next : Nat) : Term → EncoderM Unit
  | .Var name => do
      emitBits [false, false, false, false]
      let index ← deBruijnIndex next name
      encodeNat index
  | .Delay term => do
      emitBits [false, false, false, true]
      encodeTerm version next term
  | .Lam _ body => do
      emitBits [false, false, true, false]
      encodeTerm version (next + 1) body
  | .Apply function argument => do
      emitBits [false, false, true, true]
      encodeTerm version next function
      encodeTerm version next argument
  | .Const constant => do
      emitBits [false, true, false, false]
      encodeConst constant
  | .Force term => do
      emitBits [false, true, false, true]
      encodeTerm version next term
  | .Error => emitBits [false, true, true, false]
  | .Builtin builtin => do
      emitBits [false, true, true, true]
      let index ← builtinIndex builtin
      encodeFixedNat 7 index
  | .Constr index fields => do
      ensureM (decide (¬ version < Version.Version 1 1 0))
      ensureM (index < 2 ^ 64)
      emitBits [true, false, false, false]
      encodeNat index
      encodeList (encodeTerm version next) fields
  | .Case scrutinee branches => do
      ensureM (decide (¬ version < Version.Version 1 1 0))
      emitBits [true, false, false, true]
      encodeTerm version next scrutinee
      encodeList (encodeTerm version next) branches

def encodeVersion : Version → EncoderM Unit
  | .Version major minor patch => do
      encodeNat major
      encodeNat minor
      encodeNat patch

def bitsToByte (bits : List Bool) : Nat :=
  bits.foldl (fun value bit => 2 * value + if bit then 1 else 0) 0

partial def bitsToChars : List Bool → Option (List Char)
  | [] => some []
  | bits => do
      if bits.length < 8 then none
      let byte := Char.ofNat (bitsToByte (bits.take 8))
      let remaining ← bitsToChars (bits.drop 8)
      some (byte :: remaining)

def encodeProgramFlat (program : Program) : Option String := do
  let (_, bits) ←
    match program with
    | .Program version term =>
        (do
          encodeVersion version
          encodeTerm version 0 term
          emitPadding) #[]
  let bytes ← bitsToChars bits.toList
  some (String.mk bytes)

def encodeSingleCbor (program : Program) : Option String := do
  let flat ← encodeProgramFlat program
  let head ← PlutusCore.Cbor.CborInternal.encodeHead 2 flat.length
  some (String.mk (head ++ flat.data))

open Lean Elab Command Meta
open Lean.Elab.Term

syntax (name := hexFileBytesMacro) "hexFileBytesM" str : term

@[term_elab hexFileBytesMacro]
def elaborateHexFileBytes : TermElab := fun stx _ => do
  let input := stx[1]
  let some filename := input.isStrLit?
    | throwErrorAt input "string literal expected for filename"
  let content ← liftM <| IO.FS.readFile (System.FilePath.mk filename)
  let hex := content.trim
  match PlutusCore.UPLC.ScriptEncoding.Internal.hexStringToString hex.data [] with
  | some bytes => pure (Lean.toExpr (String.mk bytes))
  | none => throwErrorAt input "file is not even-length hexadecimal"

def oneShotLockedCbor : String :=
  hexFileBytesM "artifacts/active-preprod/one-shot-params-nft.cbor.hex"

def paramsHolderLockedCbor : String :=
  hexFileBytesM "artifacts/active-preprod/reclaim-params-holder.cbor.hex"

def reclaimBaseLockedCbor : String :=
  hexFileBytesM "artifacts/active-preprod/reclaim-base.cbor.hex"

def reclaimBaseCandidateCbor : String :=
  hexFileBytesM "artifacts/candidate/reclaim-base.cbor.hex"

def reclaimGlobalV2LockedCbor : String :=
  hexFileBytesM "artifacts/active-preprod/reclaim-global-v2.cbor.hex"

def reclaimGlobalV2CandidateCbor : String :=
  hexFileBytesM "artifacts/candidate/reclaim-global-v2.cbor.hex"

theorem oneShot_import_roundtrips_to_locked_exporter_bytes :
    encodeSingleCbor oneShotParamsNFT.script = some oneShotLockedCbor := by
  native_decide

theorem paramsHolder_import_roundtrips_to_locked_exporter_bytes :
    encodeSingleCbor paramsHolder.script = some paramsHolderLockedCbor := by
  native_decide

theorem reclaimBase_import_roundtrips_to_locked_exporter_bytes :
    encodeSingleCbor reclaimBase.script = some reclaimBaseLockedCbor := by
  native_decide

theorem reclaimBaseCandidate_import_roundtrips_to_exporter_bytes :
    encodeSingleCbor reclaimBaseCandidate.script = some reclaimBaseCandidateCbor := by
  native_decide

set_option maxRecDepth 100000 in
theorem reclaimGlobalV2_import_roundtrips_to_locked_exporter_bytes :
    encodeSingleCbor reclaimGlobalV2.script = some reclaimGlobalV2LockedCbor := by
  native_decide

set_option maxRecDepth 100000 in
theorem reclaimGlobalV2Candidate_import_roundtrips_to_exporter_bytes :
    encodeSingleCbor reclaimGlobalV2Candidate.script =
      some reclaimGlobalV2CandidateCbor := by
  native_decide

#print axioms oneShot_import_roundtrips_to_locked_exporter_bytes
#print axioms paramsHolder_import_roundtrips_to_locked_exporter_bytes
#print axioms reclaimBase_import_roundtrips_to_locked_exporter_bytes
#print axioms reclaimBaseCandidate_import_roundtrips_to_exporter_bytes
#print axioms reclaimGlobalV2_import_roundtrips_to_locked_exporter_bytes
#print axioms reclaimGlobalV2Candidate_import_roundtrips_to_exporter_bytes

end ProofToolFormal.FlatRoundTrip
