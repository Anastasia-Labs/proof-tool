{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module Main (main) where

import Control.Exception (SomeException, evaluate, finally, try)
import Control.Monad (forM_)
import Data.Aeson (Value (..), eitherDecode, encode, toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KeyMap
import qualified Data.ByteString.Lazy as BL
import Data.Char (digitToInt, isHexDigit)
import Data.Foldable (toList)
import Data.List (nubBy, zipWith4)

import qualified PlutusCore as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusCore.Evaluation.Machine.MachineParameters.Default
  ( DefaultMachineParameters
  )
import qualified PlutusCore.MkPlc as PLC
import PlutusLedgerApi.Common
  ( ScriptNamedDeBruijn (..)
  , deserialisedScript
  )
import qualified PlutusTx.Builtins as B
import PlutusTx.Builtins
  ( BuiltinBLS12_381_G1_Element
  , BuiltinByteString
  , BuiltinData
  , ByteOrder (BigEndian, LittleEndian)
  )
import qualified PlutusTx.Builtins.Internal as BI
import PlutusTx (CompiledCode)
import qualified PlutusTx
import qualified PlutusTx.AssocMap as Map
import qualified UntypedPlutusCore as UPLC
import qualified UntypedPlutusCore.Evaluation.Machine.Cek as Cek

import Ownership.OneShotNFT (oneShotNFTPolicy)
import Ownership.ReclaimBase
  ( ReclaimBaseDatum (..)
  , reclaimBaseValidatorBuiltin
  , reclaimBaseValidatorCode
  , txInfoWdrlFromContextData
  )
import Ownership.ReclaimGlobal
  ( foldBatchScalarState
  , retainBatchScalarState
  , reclaimGlobalParamsData
  , reclaimProofBytesConcat
  , reclaimGlobalRedeemerData
  , reclaimSameAsPreviousProof
  , reclaimGlobalValidator
  , reclaimGlobalValidatorCode
  , valueCoversData
  )
import qualified Ownership.ReclaimGlobalV2Bench as V2Global
import qualified Ownership.ReclaimGlobalV2 as StatementV2
import Ownership.ReclaimGlobalMulti
  ( destinationAddressV1FromTxOutData
  , multiCredentialCountU16BE
  , multiCredentialPublicInputDigest
  , multiOwnershipDomain
  , reclaimGlobalMultiRedeemerData
  , reclaimGlobalMultiValidator
  , validateMultiReclaimInputsWithProofCheck
  )
import qualified Ownership.ReclaimGlobalMultiV2Bench as V2Multi
import Ownership.Verify
  ( BatchCommittedProofCheck (..)
  , CommittedProofCheck (..)
  , ParsedBatchVerifyingKey (..)
  , ParsedVerifyingKey (..)
  , Proof (Proof)
  , Scalar (Scalar)
  , batchCoefficientUsesUnscaledAlpha
  , blsBaseFieldOrder
  , blsScalarFieldOrder
  , coefficientFirstVkX
  , commitmentYIsCanonical
  , committedProofMergedBatchSidesWithBatchVK
  , committedProofMergedSidesWithVK
  , expandMsgXmd48
  , groth16VerifyCommittedParsedNoPok
  , ownershipDestinationDomain
  , ownershipDestinationPublicInputDigest
  , ownershipDomain
  , ownershipProofBatchChallenge
  , ownershipProofBatchChallengeV2
  , ownershipProofBatchDomainV2
  , ownershipProofBatchMergeChallenge
  , ownershipProofBatchMergeChallengeV2
  , ownershipPublicInputDigest
  , parseVerifyingKey
  , parseVerifyingKeyBatch
  , verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
  , verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok
  , verifyOwnershipDestinationWithParsedVKKnown28NoPok
  , verifyCommittedProofGrothBatch
  , verifyCommittedProofMergedBatchWithBatchVK
  , verifyCommittedProofMergedWithVK
  , verifyCommittedProofPokBatchWithBatchVK
  , verifyCommittedProofPokBatch
  , verifyOwnershipWithVK
  )
import qualified PlutusLedgerApi.V1.Value as Value
import qualified PlutusLedgerApi.V3 as V3
import Protocol11Snapshot
  ( Protocol11Snapshot (..)
  , loadProtocol11Snapshot
  )
import ReclaimBaseOracle (reclaimBaseValidatorOracle)
import ScriptContextBuilder
import System.Directory (removeFile)
import System.Exit (ExitCode (ExitFailure))
import System.IO (hClose, openBinaryTempFile)
import System.Process (readProcessWithExitCode)

import Test.Tasty
import Test.Tasty.HUnit
import qualified Test.Tasty.QuickCheck as QC
import V4BlindValueCoverage (v4BlindValueCoverageTests)

decodeHex :: String -> [Integer]
decodeHex = go . filter isHexDigit
  where
    go (hi : lo : rest) = fromIntegral (digitToInt hi * 16 + digitToInt lo) : go rest
    go [] = []
    go [_] = error "decodeHex: odd number of hex digits"

bytesToBuiltin :: [Integer] -> BuiltinByteString
bytesToBuiltin = foldr B.consByteString B.emptyByteString

readBuiltinHex :: FilePath -> IO BuiltinByteString
readBuiltinHex path = bytesToBuiltin . decodeHex <$> readFile path

data DistinctOwnershipFixture = DistinctOwnershipFixture
  { distinctFixtureCredential :: BuiltinByteString
  , distinctFixtureProof :: BuiltinByteString
  }

readDistinctOwnershipFixtures :: FilePath -> IO [DistinctOwnershipFixture]
readDistinctOwnershipFixtures path = do
  proofLines <- filter (not . null) . lines <$> readFile path
  pure (fmap parseFixture proofLines)
  where
    parseFixture line =
      case words line of
        [_idx, credentialHex, proofHex] ->
          DistinctOwnershipFixture
            { distinctFixtureCredential = bytesToBuiltin (decodeHex credentialHex)
            , distinctFixtureProof = bytesToBuiltin (decodeHex proofHex)
            }
        _ -> error "malformed distinct ownership fixture row"

tamperProof :: BuiltinByteString -> BuiltinByteString
tamperProof proof =
  B.consByteString 0 (B.sliceByteString 1 335 proof)

proofWithCommitmentY :: Integer -> BuiltinByteString -> BuiltinByteString
proofWithCommitmentY y proof =
  B.sliceByteString 0 240 proof
    <> B.integerToByteString BigEndian 48 y
    <> B.sliceByteString 288 48 proof

replaceProofSlice :: Integer -> Integer -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString
replaceProofSlice offset width replacement proof =
  B.sliceByteString 0 offset proof
    <> replacement
    <> B.sliceByteString (offset + width) (336 - offset - width) proof

compressedIdentity :: Integer -> BuiltinByteString
compressedIdentity width =
  B.consByteString 192 (bytesToBuiltin (replicate (fromInteger width - 1) 0))

malformedCompressedPoint :: Integer -> BuiltinByteString
malformedCompressedPoint width =
  B.consByteString 255 (bytesToBuiltin (replicate (fromInteger width - 1) 255))

uncompressedCommitmentIdentity :: BuiltinByteString
uncompressedCommitmentIdentity =
  B.consByteString 64 (bytesToBuiltin (replicate 95 0))

flipFirstBit :: BuiltinByteString -> BuiltinByteString
flipFirstBit bytes =
  let firstByte = B.indexByteString bytes 0
      flipped = if even firstByte then firstByte + 1 else firstByte - 1
   in B.consByteString flipped (B.sliceByteString 1 (B.lengthOfByteString bytes - 1) bytes)

flipBitAt :: Integer -> BuiltinByteString -> BuiltinByteString
flipBitAt offset bytes =
  B.sliceByteString 0 offset bytes
    <> flipFirstBit (B.sliceByteString offset 1 bytes)
    <> B.sliceByteString (offset + 1) (B.lengthOfByteString bytes - offset - 1) bytes

replaceAt :: Int -> a -> [a] -> [a]
replaceAt index replacement values =
  take index values <> [replacement] <> drop (index + 1) values

distinctV2Context :: [DistinctOwnershipFixture] -> [BuiltinByteString] -> V3.ScriptContext
distinctV2Context fixtures proofs =
  distinctV2ContextWithOutputs fixtures proofs (replicate (length fixtures) singleDestinationOutput)

distinctV2ContextWithOutputs :: [DistinctOwnershipFixture] -> [BuiltinByteString] -> [V3.TxOut] -> V3.ScriptContext
distinctV2ContextWithOutputs fixtures proofs outputs =
  reclaimGlobalContextWithOutputs
    proofs
    0
    [ reclaimBaseInputAtWithDatum
        (B.consByteString (toInteger index) "v2-distinct")
        (toInteger index)
        (ReclaimBaseDatum (distinctFixtureCredential fixture))
    | (index, fixture) <- zip [0 :: Int ..] fixtures
    ]
    [paramInput]
    outputs

replaceProofComponentFrom :: Integer -> Integer -> BuiltinByteString -> BuiltinByteString -> BuiltinByteString
replaceProofComponentFrom offset width donor proof =
  replaceProofSlice offset width (B.sliceByteString offset width donor) proof

batchPowers :: Integer -> Int -> [Integer]
batchPowers challenge count =
  take count (iterate nextPower 1)
  where
    nextPower power = (power * challenge) `B.modInteger` blsScalarFieldOrder

foldScalarProducts :: [(Integer, Integer)] -> Integer
foldScalarProducts terms =
  sum (fmap (uncurry (*)) terms) `B.modInteger` blsScalarFieldOrder

foldWeightedG1 :: [(Integer, BuiltinBLS12_381_G1_Element)] -> BuiltinBLS12_381_G1_Element
foldWeightedG1 [] = error "foldWeightedG1: empty batch"
foldWeightedG1 ((coefficient, point) : morePoints) =
  foldl addWeighted (coefficient `B.bls12_381_G1_scalarMul` point) morePoints
  where
    addWeighted accumulated (nextCoefficient, nextPoint) =
      accumulated
        `B.bls12_381_G1_add` (nextCoefficient `B.bls12_381_G1_scalarMul` nextPoint)

syntheticVkX ::
  ParsedBatchVerifyingKey ->
  Integer ->
  Integer ->
  BuiltinBLS12_381_G1_Element ->
  BuiltinBLS12_381_G1_Element
syntheticVkX parsedVk pub eCmt commitment =
  parsedBatchIc0 parsedVk
    `B.bls12_381_G1_add` (pub `B.bls12_381_G1_scalarMul` parsedBatchIc1 parsedVk)
    `B.bls12_381_G1_add` (eCmt `B.bls12_381_G1_scalarMul` parsedBatchK2 parsedVk)
    `B.bls12_381_G1_add` commitment

assertSyntheticCoefficientFold ::
  ParsedBatchVerifyingKey ->
  [Integer] ->
  [Integer] ->
  [Integer] ->
  [BuiltinBLS12_381_G1_Element] ->
  Assertion
assertSyntheticCoefficientFold parsedVk coefficients pubs eCmts commitments = do
  let coefficientSum = sum coefficients `B.modInteger` blsScalarFieldOrder
      foldedPub = foldScalarProducts (zip coefficients pubs)
      foldedECmt = foldScalarProducts (zip coefficients eCmts)
      foldedCommitment = foldWeightedG1 (zip coefficients commitments)
      coefficientPoint =
        coefficientFirstVkX parsedVk coefficientSum foldedPub foldedECmt foldedCommitment
      legacyPoint =
        foldWeightedG1
          ( zipWith4
              (\coefficient pub eCmt commitment ->
                (coefficient, syntheticVkX parsedVk pub eCmt commitment)
              )
              coefficients
              pubs
              eCmts
              commitments
          )
  B.bls12_381_G1_compress coefficientPoint @?= B.bls12_381_G1_compress legacyPoint

v8FrozenOracle :: [(Integer, Integer, Integer, Integer)]
v8FrozenOracle =
  [ (42232951197950963605605994357055931589917384278611356998008304204808427669511, 1, 30143205349673303924038740226444575063052729468321387927570779271358684740710, 30057198112188348163071719550278976015962503732543456432613262068505530898330)
  , (574688289443204857446899937269163249965870848485071545830752000612992205487, 574688289443204857446899937269163249965870848485071545830752000612992205488, 9388395954322108607470064943104611687409909051657989531083250487867962736563, 42757823960707423414610107968618136691604664249280227568669933688955768743377)
  , (28264937978304401676353878108968682592403332391658135746521525622394280615893, 16326701921432323519342252743761017480808026245847899713096320049732563391061, 26817011969017573223599491479931618434263389747606361387343198480086572893617, 15968264536406651858779824089245868863284586417840798094591759687837857482729)
  , (1990285863334496398235456908550880119416756295414994099015045042825670448764, 23181153276457276303418933570109217595440652157140419783093870130415489167816, 5591489714749104067637334690257367698028726714598667541569579715305776099808, 26720558339781652091558791951874524579069659613977017038692808014798916286793)
  , (43870333204796204237511851611093888055828097883542622888457091088982062535878, 49087629222754944175126667084760031420945940096739387214920826446668186798512, 35327905709489106577557359788174352265317440270640386215011004755345877547224, 3978104816264518183348795515056441169943687709185178232149847054926683151779)
  , (19359938206447108703930194103034744192633111831143871258398879307554299138894, 29485143072602203829880395039730847574199183534511491117209846796171012219041, 49899327095701195020567195013156755506784511544758657043257438811387408978162, 45445041956744756262875898618543372055698456236613245290454746811364368851513)
  , (13195960267358104805784797242173292993269523286449209217903269955491653658205, 17019926201471691081436375774216171538394181185244142087536935352103316586163, 22469401930473455262821465995043452045430667896172418040792448580278473354860, 899874588725580666005797424505778437900879694447694965375004773919992469385)
  , (45518810562833489532920362512453833403697480114196953748737998419170672801943, 12228997348587389057170064753722805310466727848586975578576416868218815766879, 3078042232818701031707508056996728474815909387511143111940302956734922251977, 13647723371472867708698949638421045324089587085171503321256270686162767333906)
  ]

v2FrozenMergeChallenges :: [Integer]
v2FrozenMergeChallenges =
  [ 19773517839429401129991823080325676287963225486751004868828718271791497921877
  , 10181960934444604614995744626973632977153151706298906271780880304077758280648
  , 29472599479869945883112173355309182579677486979283789390346320938743881261998
  , 2153744383632973843082362722727721315115115372945465494748685645654740264590
  , 1130737796153501207902388487635777938097905235246486705527192944058147376907
  , 52331413108517493486364912145537169097716970795859015009190351697487014730802
  , 51833610560735126361806081041853213442614352408154196658968496374204748458539
  , 40569334593980234115359758855996206496418569441315629093128223847286622158780
  ]

v8ComputedScalars :: BuiltinByteString -> [DistinctOwnershipFixture] -> (Integer, Integer, Integer, Integer)
v8ComputedScalars verifierKey fixtures =
  let parsedBatchVk = parseVerifyingKeyBatch verifierKey
      proofBytes = fmap distinctFixtureProof fixtures
      challenge = ownershipProofBatchChallenge (mconcat proofBytes)
      coefficients = batchPowers challenge (length fixtures)
      checks =
        [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
            parsedBatchVk
            proof
            credential
            destinationAddressBytes
        | DistinctOwnershipFixture credential proof <- fixtures
        ]
   in ( challenge
      , sum coefficients `B.modInteger` blsScalarFieldOrder
      , foldScalarProducts (zip coefficients (fmap batchCommittedProofPub checks))
      , foldScalarProducts (zip coefficients (fmap batchCommittedProofECmt checks))
      )

assertCoefficientFirstMatchesLegacy ::
  BuiltinByteString ->
  [DistinctOwnershipFixture] ->
  Assertion
assertCoefficientFirstMatchesLegacy verifierKey fixtures = do
  let parsedVk = parseVerifyingKey verifierKey
      parsedBatchVk = parseVerifyingKeyBatch verifierKey
      proofBytes = fmap distinctFixtureProof fixtures
      challenge = ownershipProofBatchChallenge (mconcat proofBytes)
      coefficients = batchPowers challenge (length fixtures)
      checks =
        [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
            parsedBatchVk
            proof
            credential
            destinationAddressBytes
        | DistinctOwnershipFixture credential proof <- fixtures
        ]
      legacyChecks =
        [ verifyOwnershipDestinationWithParsedVKKnown28NoPok
            parsedVk
            proof
            credential
            destinationAddressBytes
        | DistinctOwnershipFixture credential proof <- fixtures
        ]
      coefficientSum = sum coefficients `B.modInteger` blsScalarFieldOrder
      foldedPub =
        foldScalarProducts
          (zip coefficients (fmap batchCommittedProofPub checks))
      foldedECmt =
        foldScalarProducts
          (zip coefficients (fmap batchCommittedProofECmt checks))
      foldedCommitment =
        foldWeightedG1
          (zip coefficients (fmap batchCommittedProofCommitment checks))
      coefficientFirstPoint =
        coefficientFirstVkX
          parsedBatchVk
          coefficientSum
          foldedPub
          foldedECmt
          foldedCommitment
      legacyPoint =
        foldWeightedG1
          (zip coefficients (fmap committedProofVkX legacyChecks))

  assertBool "batch challenge is in [1,q-1]" $
    challenge >= 1 && challenge < blsScalarFieldOrder
  head coefficients @?= 1
  forM_ (zip coefficients (drop 1 coefficients)) $ \(power, nextPower) ->
    nextPower @?= (power * challenge) `B.modInteger` blsScalarFieldOrder
  assertBool "all batch coefficients are canonical field integers" $
    all (\coefficient -> coefficient >= 0 && coefficient < blsScalarFieldOrder) coefficients
  assertBool "all production batch powers are nonzero" (all (/= 0) coefficients)

  forM_ (zip fixtures checks) $ \(DistinctOwnershipFixture credential proof, check) -> do
    batchCommittedProofPub check
      @?= ( B.byteStringToInteger
              LittleEndian
              (ownershipDestinationPublicInputDigest credential destinationAddressBytes)
              `B.modInteger` blsScalarFieldOrder
          )
    batchCommittedProofECmt check
      @?= ( B.byteStringToInteger
              BigEndian
              (expandMsgXmd48 (B.sliceByteString 192 96 proof))
              `B.modInteger` blsScalarFieldOrder
          )

  B.bls12_381_G1_compress coefficientFirstPoint
    @?= B.bls12_381_G1_compress legacyPoint

safeVerify :: BuiltinByteString -> BuiltinByteString -> BuiltinByteString -> IO Bool
safeVerify vk proof pkh = do
  r <- try (evaluate (verifyOwnershipWithVK vk proof pkh))
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

safeBool :: Bool -> IO Bool
safeBool value = do
  r <- try (evaluate value)
  pure $ case r of
    Left (_ :: SomeException) -> False
    Right ok                  -> ok

builtinBoolToBool :: BI.BuiltinBool -> Bool
builtinBoolToBool condition =
  BI.ifThenElse condition (\_ -> True) (\_ -> False) BI.unitval

runReclaimGlobal :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobal verifierKey ctx =
  reclaimGlobalValidator paramCurrencySymbol paramTokenName verifierKey (V3.toBuiltinData ctx)

runReclaimGlobalV2 :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobalV2 verifierKey ctx =
  V2Global.reclaimGlobalValidator paramCurrencySymbol paramTokenName verifierKey (V3.toBuiltinData ctx)

runReclaimGlobalStatementV2 :: BuiltinByteString -> BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobalStatementV2 verifierKey verifierKeyHash ctx =
  StatementV2.reclaimGlobalValidatorV2 paramCurrencySymbol paramTokenName verifierKey verifierKeyHash (V3.toBuiltinData ctx)

runReclaimGlobalMulti :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobalMulti verifierKey ctx =
  reclaimGlobalMultiValidator paramCurrencySymbol paramTokenName verifierKey (V3.toBuiltinData ctx)

runReclaimGlobalMultiV2 :: BuiltinByteString -> V3.ScriptContext -> Bool
runReclaimGlobalMultiV2 verifierKey ctx =
  V2Multi.reclaimGlobalMultiValidator paramCurrencySymbol paramTokenName verifierKey (V3.toBuiltinData ctx)

runRawReclaimBase :: V3.Credential -> V3.ScriptContext -> Bool
runRawReclaimBase credential ctx =
  builtinBoolToBool $
    reclaimBaseValidatorBuiltin
      (V3.toBuiltinData credential)
      (V3.toBuiltinData ctx)

compiledReclaimBaseScript :: V3.Credential -> Script
compiledReclaimBaseScript credential =
  compiledToProgram $
    reclaimBaseValidatorCode
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef (V3.toBuiltinData credential)

runCompiledReclaimBase :: V3.Credential -> V3.ScriptContext -> Bool
runCompiledReclaimBase credential ctx =
  fst (evaluateCompiledScript (compiledReclaimBaseScript credential) ctx)

compiledReclaimGlobalScript :: BuiltinByteString -> Script
compiledReclaimGlobalScript verifierKey =
  compiledToProgram $
    reclaimGlobalValidatorCode
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramCurrencySymbol
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey

compiledReclaimGlobalStatementV2Script :: BuiltinByteString -> BuiltinByteString -> Script
compiledReclaimGlobalStatementV2Script verifierKey verifierKeyHash =
  compiledToProgram $
    StatementV2.reclaimGlobalValidatorV2Code
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramCurrencySymbol
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKey
      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef verifierKeyHash

assertCompiledReclaimGlobalStatementV2Rejects :: String -> BuiltinByteString -> BuiltinByteString -> V3.ScriptContext -> Assertion
assertCompiledReclaimGlobalStatementV2Rejects label verifierKey verifierKeyHash ctx = do
  let (succeeded, logsEmpty) =
        evaluateCompiledScript
          (compiledReclaimGlobalStatementV2Script verifierKey verifierKeyHash)
          ctx
  assertBool (label <> " unexpectedly succeeded") (not succeeded)
  assertBool (label <> " emitted trace output from the production script") logsEmpty

assertCompiledReclaimGlobalRejects :: String -> BuiltinByteString -> BuiltinByteString -> Assertion
assertCompiledReclaimGlobalRejects label verifierKey proof = do
  let (succeeded, logsEmpty) =
        evaluateCompiledScript
          (compiledReclaimGlobalScript verifierKey)
          (reclaimGlobalContext proof 0 [reclaimBaseInput] [paramInput])
  assertBool (label <> " unexpectedly succeeded") (not succeeded)
  assertBool (label <> " emitted trace output from the production script") logsEmpty

type Script = UPLC.Program UPLC.DeBruijn PLC.DefaultUni PLC.DefaultFun ()

compiledToProgram :: CompiledCode a -> Script
compiledToProgram code =
  let script =
        either (error . ("failed to deserialise compiled script: " <>) . show) id $
          V3.deserialiseScript protocolVersion (V3.serialiseCompiledCode code)
      ScriptNamedDeBruijn program = deserialisedScript script
   in toNameless program

toNameless ::
  UPLC.Program UPLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun () ->
  Script
toNameless (UPLC.Program ann version term) =
  UPLC.Program ann version (UPLC.termMapNames UPLC.unNameDeBruijn term)

evaluateCompiledScript :: Script -> V3.ScriptContext -> (Bool, Bool)
evaluateCompiledScript script ctx =
  let UPLC.Program _ _ term = applyContextArgument script ctx
      namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        defaultCekParametersForTesting
        (Cek.restricting (ExRestrictingBudget unlimitedBudget))
        Cek.logEmitter
        namedTerm of
        (Right _, _, logs) -> (True, null logs)
        (Left _, _, logs)  -> (False, null logs)

evaluateCompiledScriptWith ::
  DefaultMachineParameters ->
  Script ->
  V3.ScriptContext ->
  (Bool, ExBudget, Bool)
evaluateCompiledScriptWith machineParameters script ctx =
  let UPLC.Program _ _ term = applyContextArgument script ctx
      namedTerm = UPLC.termMapNames UPLC.fakeNameDeBruijn term
   in case Cek.runCekDeBruijn
        machineParameters
        Cek.counting
        Cek.logEmitter
        namedTerm of
        (Right _, Cek.CountingSt budget, logs) -> (True, budget, null logs)
        (Left _, Cek.CountingSt budget, logs)  -> (False, budget, null logs)

applyContextArgument :: Script -> V3.ScriptContext -> Script
applyContextArgument (UPLC.Program ann version term) ctx =
  UPLC.Program ann version $
    PLC.mkIterAppNoAnn term [PLC.mkConstant () (V3.toData ctx)]

unlimitedBudget :: ExBudget
unlimitedBudget = ExBudget (ExCPU maxBound) (ExMemory maxBound)

protocolVersion :: V3.MajorProtocolVersion
protocolVersion = V3.MajorProtocolVersion 11

renderExBudget :: ExBudget -> String
renderExBudget (ExBudget (ExCPU cpu) (ExMemory memory)) =
  "memory="
    <> show (V3.fromSatInt memory :: Integer)
    <> ",cpu="
    <> show (V3.fromSatInt cpu :: Integer)

protocol11SnapshotPath :: FilePath
protocol11SnapshotPath = "bench/results/preprod-protocol-v11-epoch-300.json"

withEncodedSnapshot :: Value -> (FilePath -> IO a) -> IO a
withEncodedSnapshot value action = do
  (path, handle) <- openBinaryTempFile "/tmp" "protocol-v11-snapshot.json"
  BL.hPut handle (encode value)
  hClose handle
  action path `finally` removeFile path

mutatePlutusV3Model :: ([Value] -> [Value]) -> Value -> Value
mutatePlutusV3Model mutation (Object snapshot) =
  Object $ adjustKey "protocol_parameters" mutateProtocolParameters snapshot
  where
    mutateProtocolParameters (Object parameters) =
      Object $ adjustKey "costModels" mutateCostModels parameters
    mutateProtocolParameters other = other
    mutateCostModels (Object models) =
      Object $ adjustKey "PlutusV3" mutateModel models
    mutateCostModels other = other
    mutateModel (Array values) = toJSON (mutation (toList values))
    mutateModel other = other
mutatePlutusV3Model _ other = other

adjustKey :: Key.Key -> (Value -> Value) -> KeyMap.KeyMap Value -> KeyMap.KeyMap Value
adjustKey key update object =
  case KeyMap.lookup key object of
    Nothing -> object
    Just value -> KeyMap.insert key (update value) object

dropLast :: [a] -> [a]
dropLast [] = []
dropLast values = init values

swapFirstTwo :: [a] -> [a]
swapFirstTwo (first : second : rest) = second : first : rest
swapFirstTwo values = values

replaceFirstMalformed :: [Value] -> [Value]
replaceFirstMalformed (_ : rest) = String "malformed" : rest
replaceFirstMalformed [] = [String "malformed"]

main :: IO ()
main = do
  vk <- readBuiltinHex "testdata/ownership-vk.hex"
  proof <- readBuiltinHex "testdata/ownership-proof.hex"
  destinationVk <- readBuiltinHex "testdata/ownership-destination-vk.hex"
  destinationProof <- readBuiltinHex "testdata/ownership-destination-proof.hex"
  destinationPub <- readBuiltinHex "testdata/ownership-destination-pub.hex"
  multiVk <- readBuiltinHex "testdata/multi-count2-vk.hex"
  multiProof <- readBuiltinHex "testdata/multi-count2-proof.hex"
  multiPub <- readBuiltinHex "testdata/multi-count2-pub.hex"
  distinctFixtures <-
    readDistinctOwnershipFixtures "testdata/ownership-destination-distinct-proofs.txt"
  (firstDistinctProof, secondDistinctProof) <-
    case distinctFixtures of
      firstFixture : secondFixture : _ ->
        pure (distinctFixtureProof firstFixture, distinctFixtureProof secondFixture)
      _ -> error "distinct ownership fixture file has fewer than two proofs"
  let pkh = goldenPaymentKeyHash
      wrongPkh = wrongPaymentKeyHash

  defaultMain $ testGroup "ownership-verifier"
    [ v4BlindValueCoverageTests
    , testGroup "Ownership.Verify"
        [ testCase "public input digest binds the ownership domain and payment key hash" $
            ownershipPublicInputDigest pkh @?= B.blake2b_256 (ownershipDomain <> pkh)
        , testCase "destination public input digest binds payment key hash and destination address" $ do
            ownershipDestinationPublicInputDigest pkh destinationAddressBytes
              @?= B.blake2b_256 (ownershipDestinationDomain <> pkh <> destinationAddressBytes)
            destinationPub @?= ownershipDestinationPublicInputDigest pkh destinationAddressBytes
        , testCase "rejects non-28-byte payment key hashes before proof parsing" $
            verifyOwnershipWithVK "" "" "short" @?= False
        , testCase "accepts the exported real ownership proof for its payment key hash" $ do
            ok <- safeVerify vk proof pkh
            ok @?= True
        , testCase "rejects committed proofs whose wire length is not exactly 336 bytes" $ do
            trailing <- safeVerify vk (proof <> B.consByteString 0 B.emptyByteString) pkh
            truncated <- safeVerify vk (B.sliceByteString 0 335 proof) pkh
            empty <- safeVerify vk B.emptyByteString pkh
            trailing @?= False
            truncated @?= False
            empty @?= False
        , testCase "rejects verifying keys whose wire length is not exactly 672 bytes" $ do
            trailing <- safeVerify (vk <> B.consByteString 0 B.emptyByteString) proof pkh
            truncated <- safeVerify (B.sliceByteString 0 671 vk) proof pkh
            trailing @?= False
            truncated @?= False
        , testCase "rejects a commitment encoding with Y equal to the BLS base-field modulus" $ do
            let nonCanonicalProof = proofWithCommitmentY blsBaseFieldOrder proof
            commitmentYIsCanonical proof @?= True
            commitmentYIsCanonical nonCanonicalProof @?= False
            ok <- safeVerify vk nonCanonicalProof pkh
            ok @?= False
        , testCase "rejects the exported proof for a different payment key hash" $ do
            ok <- safeVerify vk proof wrongPkh
            ok @?= False
        , testCase "V6 alpha and V8 IC0 fast paths compare exact 1, not 1+q" $ do
            builtinBoolToBool (batchCoefficientUsesUnscaledAlpha 1) @?= True
            builtinBoolToBool (batchCoefficientUsesUnscaledAlpha (1 + blsScalarFieldOrder)) @?= False
        , testCase "two distinct proofs produce sum 1+r and do not take the batch alpha fast path" $ do
            assertBool "distinct fixtures must carry different proof bytes" (firstDistinctProof /= secondDistinctProof)
            let r = ownershipProofBatchChallenge (firstDistinctProof <> secondDistinctProof)
                coefficientSum = (1 + r) `B.modInteger` blsScalarFieldOrder
            assertBool "batch challenge must be nonzero" (r >= 1)
            assertBool "two-distinct coefficient sum must not equal one" (coefficientSum /= 1)
            builtinBoolToBool (batchCoefficientUsesUnscaledAlpha coefficientSum) @?= False
        , testGroup "V8 coefficient-first vkX equals legacy point-first folding" $
            [ testCase ("P1/P7 frozen distinct N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                v8ComputedScalars destinationVk fixtures @?= (v8FrozenOracle !! (inputCount - 1))
                assertCoefficientFirstMatchesLegacy destinationVk fixtures
            | inputCount <- [1 .. 8]
            ]
        , testCase "V8 coefficient folding preserves proof/public-input order algebraically" $ do
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] ->
                assertCoefficientFirstMatchesLegacy
                  destinationVk
                  [ firstFixture
                      { distinctFixtureCredential = distinctFixtureCredential secondFixture
                      }
                  , secondFixture
                      { distinctFixtureCredential = distinctFixtureCredential firstFixture
                      }
                  ]
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "P2 synthetic r=1 produces plain N=8 sums" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                fixtures = take 8 distinctFixtures
                checks =
                  [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed (distinctFixtureProof fixture) (distinctFixtureCredential fixture) destinationAddressBytes
                  | fixture <- fixtures
                  ]
                coefficients = replicate 8 1
                pubs = [0 .. 7]
                eCmts = [8 .. 15]
                commitments = fmap batchCommittedProofCommitment checks
            batchPowers 1 8 @?= coefficients
            sum coefficients `B.modInteger` blsScalarFieldOrder @?= 8
            foldScalarProducts (zip coefficients pubs) @?= sum pubs
            foldScalarProducts (zip coefficients eCmts) @?= sum eCmts
            assertSyntheticCoefficientFold parsed coefficients pubs eCmts commitments
        , testCase "P3 synthetic r=q-1 alternates powers and preserves zero S0" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                checks =
                  [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed (distinctFixtureProof fixture) (distinctFixtureCredential fixture) destinationAddressBytes
                  | fixture <- take 8 distinctFixtures
                  ]
            forM_ [2 .. 8] $ \inputCount -> do
              let coefficients = batchPowers (blsScalarFieldOrder - 1) inputCount
                  pubs = take inputCount [3 ..]
                  eCmts = take inputCount [19 ..]
                  commitments = take inputCount (fmap batchCommittedProofCommitment checks)
              coefficients @?= take inputCount (cycle [1, blsScalarFieldOrder - 1])
              assertSyntheticCoefficientFold parsed coefficients pubs eCmts commitments
            let zeroS0 = sum (batchPowers (blsScalarFieldOrder - 1) 2) `B.modInteger` blsScalarFieldOrder
            zeroS0 @?= 0
            builtinBoolToBool (batchCoefficientUsesUnscaledAlpha zeroS0) @?= False
        , testCase "P4 scalar inputs and products normalize modulo q" $ do
            let raw = [0, 1, blsScalarFieldOrder - 1, blsScalarFieldOrder, blsScalarFieldOrder + 1, 2 * blsScalarFieldOrder - 1, 2 * blsScalarFieldOrder]
                normalized = fmap (`B.modInteger` blsScalarFieldOrder) raw
                expected = [0, 1, blsScalarFieldOrder - 1, 0, 1, blsScalarFieldOrder - 1, 0]
                parsed = parseVerifyingKeyBatch destinationVk
                checks =
                  [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed (distinctFixtureProof fixture) (distinctFixtureCredential fixture) destinationAddressBytes
                  | fixture <- take 7 distinctFixtures
                  ]
            normalized @?= expected
            foldScalarProducts (zip (replicate 7 1) raw)
              @?= foldScalarProducts (zip (replicate 7 1) expected)
            foldScalarProducts (zip raw raw)
              @?= foldScalarProducts (zip expected expected)
            assertSyntheticCoefficientFold
              parsed
              (replicate 7 1)
              raw
              raw
              (fmap batchCommittedProofCommitment checks)
        , testCase "P5/P6 zero scalar columns preserve every other term" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                checks =
                  [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed (distinctFixtureProof fixture) (distinctFixtureCredential fixture) destinationAddressBytes
                  | fixture <- take 3 distinctFixtures
                  ]
                commitments = fmap batchCommittedProofCommitment checks
                scenarios =
                  [ ([1, 7, 49], [0, 3, 4], [5, 0, 6])
                  , ([1, 7, 49], [0, 3, 4], [0, 5, 6])
                  , ([1, 7, 49], [0, 3, 4], [0, 0, 0])
                  , ([1, 1], [9, blsScalarFieldOrder - 9], [2, 3])
                  , ([1, 1], [2, 3], [11, blsScalarFieldOrder - 11])
                  , ([1, 1], [9, blsScalarFieldOrder - 9], [11, blsScalarFieldOrder - 11])
                  ]
            forM_ scenarios $ \(coefficients, pubs, eCmts) ->
              assertSyntheticCoefficientFold parsed coefficients pubs eCmts (take (length coefficients) commitments)
            foldScalarProducts (zip [1, 1] [9, blsScalarFieldOrder - 9]) @?= 0
            foldScalarProducts (zip [1, 1] [11, blsScalarFieldOrder - 11]) @?= 0
        , testCase "F2 fixed-base wiring mutations differ from the legacy point" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                fixtures = take 2 distinctFixtures
                proofBytes = fmap distinctFixtureProof fixtures
                challenge = ownershipProofBatchChallenge (mconcat proofBytes)
                coefficients = batchPowers challenge 2
                checks =
                  [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed (distinctFixtureProof fixture) (distinctFixtureCredential fixture) destinationAddressBytes
                  | fixture <- fixtures
                  ]
                s0 = sum coefficients `B.modInteger` blsScalarFieldOrder
                sPub = foldScalarProducts (zip coefficients (fmap batchCommittedProofPub checks))
                sE = foldScalarProducts (zip coefficients (fmap batchCommittedProofECmt checks))
                foldedD = foldWeightedG1 (zip coefficients (fmap batchCommittedProofCommitment checks))
                identity = 0 `B.bls12_381_G1_scalarMul` parsedBatchIc0 parsed
                correct = coefficientFirstVkX parsed s0 sPub sE foldedD
                swappedScalars = coefficientFirstVkX parsed s0 sE sPub foldedD
                swappedBases =
                  (s0 `B.bls12_381_G1_scalarMul` parsedBatchIc0 parsed)
                    `B.bls12_381_G1_add` (sPub `B.bls12_381_G1_scalarMul` parsedBatchK2 parsed)
                    `B.bls12_381_G1_add` (sE `B.bls12_381_G1_scalarMul` parsedBatchIc1 parsed)
                    `B.bls12_381_G1_add` foldedD
                doubledD = coefficientFirstVkX parsed s0 sPub sE (foldedD `B.bls12_381_G1_add` foldedD)
                omittedD = coefficientFirstVkX parsed s0 sPub sE identity
                correctBytes = B.bls12_381_G1_compress correct
            forM_ [swappedScalars, swappedBases, doubledD, omittedD] $ \mutated ->
              assertBool "fixed-base wiring mutation matched legacy fold" $
                B.bls12_381_G1_compress mutated /= correctBytes
        , testCase "P7 frozen transcript challenges remain exact" $ do
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let proof1 = distinctFixtureProof firstFixture
                    proof2 = distinctFixtureProof secondFixture
                ownershipProofBatchChallenge (proof1 <> proof2)
                  @?= 574688289443204857446899937269163249965870848485071545830752000612992205487
                ownershipProofBatchChallenge (proof2 <> proof1)
                  @?= 5118056365470986225974375444968536603084952601005029251122960105471652186579
                ownershipProofBatchChallenge (flipFirstBit proof1 <> proof2)
                  @?= 9782164271061657354965960884870796192332404144925642155870528531132933098474
                ownershipProofBatchChallenge (proof1 <> proof1)
                  @?= 41436764415069209347131063773015031542171589160913649995701640637377015364735
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        ]
    , testGroup "Ownership.OneShotNFT"
        [ testCase "accepts when the seed UTxO is spent and one own token is minted" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1)])]))
              @?= True
        , testCase "rejects when the seed UTxO is not spent" $
            oneShotNFTPolicy seedRef (mintingContext [otherRef] (mintValue [(ownSymbol, [(tokenName, 1)])]))
              @?= False
        , testCase "rejects multiple own tokens" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 2)])]))
              @?= False
        , testCase "rejects own burns mixed with the mint" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1), (otherTokenName, -1)])]))
              @?= False
        , testCase "ignores minting under other policies when exactly one own token is minted" $
            oneShotNFTPolicy seedRef (mintingContext [seedRef] (mintValue [(ownSymbol, [(tokenName, 1)]), (otherSymbol, [(otherTokenName, 10)])]))
              @?= True
        ]
    , testGroup "Ownership.ReclaimBase"
        [ testCase "accepts a spending context with datum and global withdrawal" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)])
              @?= True
        , testCase "ignores the global withdrawal amount" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 1234567)])
              @?= True
        , testCase "rejects when the global withdrawal is missing" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext (Just validBaseDatum) [])
              @?= False
        , testCase "serialized trace-stripped script still rejects a missing global withdrawal" $ do
            let script =
                  compiledToProgram $
                    reclaimBaseValidatorCode
                      `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef (V3.toBuiltinData globalCredential)
                (succeeded, emittedNoLogs) =
                  evaluateCompiledScript
                    script
                    (reclaimBaseContext (Just validBaseDatum) [])
            assertBool "compiled validator must preserve the traced failure branch" (not succeeded)
            assertBool "remove-trace must remove the failure message" emittedNoLogs
        , testCase "rejects missing datum" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext Nothing [(globalCredential, 0)])
              @?= False
        , testCase "rejects non-28-byte datum key hash" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext (Just invalidBaseDatum) [(globalCredential, 0)])
              @?= False
        , testCase "rejects a key credential even when its withdrawal is present" $
            reclaimBaseValidatorOracle keyGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(keyGlobalCredential, 0)])
              @?= False
        , testCase "raw validator accepts the golden inline datum with multiple mixed withdrawals" $
            runCompiledReclaimBase
              globalCredential
              ( reclaimBaseContext
                  (Just validBaseDatum)
                  [(keyGlobalCredential, 4), (otherGlobalCredential, 9), (globalCredential, 1234567)]
              )
              @?= True
        , testGroup "raw validator rejects wrong datum lengths" $
            [ testCase ("length " <> show datumLength) $
                runCompiledReclaimBase
                  globalCredential
                  (reclaimBaseContextForDatum (DatumInlineWrongLength datumLength) [(globalCredential, 0)])
                  @?= False
            | datumLength <- [0, 5, 27, 29, 64]
            ]
        , testGroup "raw validator rejects malformed inline datum encodings" $
            [ testCase label $
                runCompiledReclaimBase
                  globalCredential
                  (reclaimBaseContextForDatum datumMode [(globalCredential, 0)])
                  @?= False
            | (label, datumMode) <-
                [ ("wrong constructor", DatumInlineWrongConstructor)
                , ("missing constructor field", DatumInlineNoFields)
                , ("non-bytes credential field", DatumInlineNonBytesField)
                ]
            ]
        , testCase "raw validator preserves typed-decoder acceptance of trailing datum fields" $
            runCompiledReclaimBase
              globalCredential
              (reclaimBaseContextForDatum DatumInlineExtraField [(globalCredential, 0)])
              @?= True
        , testCase "raw validator rejects a missing datum" $
            runCompiledReclaimBase globalCredential (reclaimBaseContext Nothing [(globalCredential, 0)])
              @?= False
        , testCase "raw validator rejects datum-by-hash" $
            runCompiledReclaimBase globalCredential (reclaimBaseContextForDatum DatumByHash [(globalCredential, 0)])
              @?= False
        , testCase "raw validator rejects an absent withdrawal" $
            runCompiledReclaimBase globalCredential (reclaimBaseContext (Just validBaseDatum) [(otherGlobalCredential, 0)])
              @?= False
        , testCase "raw validator rejects a wrong configured global credential" $
            runCompiledReclaimBase otherGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)])
              @?= False
        , testCase "raw validator rejects a key-shaped configured global credential" $
            runCompiledReclaimBase keyGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(keyGlobalCredential, 0)])
              @?= False
        , testGroup "raw validator rejects every non-Spending V3 ScriptInfo variant" $
            [ testCase label $
                runCompiledReclaimBase
                  globalCredential
                  (withBasePurpose purpose (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)]))
                  @?= False
            | (label, purpose) <-
                [ ("MintingScript", PurposeMinting)
                , ("RewardingScript", PurposeRewarding)
                , ("CertifyingScript", PurposeCertifying)
                , ("VotingScript", PurposeVoting)
                , ("ProposingScript", PurposeProposing)
                ]
            ]
        , testCase "plutus-ledger-api 1.38 full TxInfo layout walk selects txInfoWdrl field 6" $ do
            let ctx =
                  reclaimBaseContext
                    (Just validBaseDatum)
                    [(keyGlobalCredential, 3), (globalCredential, 7), (otherGlobalCredential, 11)]
                expectedWdrl = V3.toBuiltinData (V3.txInfoWdrl (V3.scriptContextTxInfo ctx))
                walkedWdrl = txInfoWdrlFromContextData (V3.toBuiltinData ctx)
            B.equalsData walkedWdrl expectedWdrl @?= True
        -- Stage 2b acceptance-equivalence qualification: configure at least
        -- 5,000 successes; checkCoverage may run more for confidence.
        , localOption (QC.QuickCheckTests 5000) $
            QC.testProperty "raw walker matches the old typed oracle on randomized well-formed contexts" $
              QC.forAllShrink
                genReclaimBaseDifferentialCase
                shrinkReclaimBaseDifferentialCase
                reclaimBaseDifferentialProperty
        ]
    , testGroup "V2 benchmark-only merged finalVerify"
        [ testGroup "frozen merge challenge"
            [ testCase ("S1 exact distinct N=" <> show inputCount) $ do
                let transcript = mconcat (fmap distinctFixtureProof (take inputCount distinctFixtures))
                    mergeChallenge = ownershipProofBatchMergeChallenge transcript
                mergeChallenge @?= v2FrozenMergeChallenges !! (inputCount - 1)
                assertBool "merge challenge must be nonzero and canonical"
                  (mergeChallenge >= 1 && mergeChallenge < blsScalarFieldOrder)
            | inputCount <- [1 .. 8]
            ]
        , testCase "S1 reordered, tampered, repeated-marker, and Multi vectors" $ do
            let proof1 = distinctFixtureProof (head distinctFixtures)
                proof2 = distinctFixtureProof (distinctFixtures !! 1)
                markerTranscript =
                  V2Global.reclaimProofBytesConcat
                    (proofSlotData [proof1, V2Global.reclaimSameAsPreviousProof])
            ownershipProofBatchMergeChallenge (proof2 <> proof1)
              @?= 10915277823268748703619030467269450801332072240431362142682744690235164716318
            ownershipProofBatchMergeChallenge (flipBitAt 0 proof1 <> proof2)
              @?= 51894838173742327532100307361815447185237656298283011327481543215908079962193
            ownershipProofBatchMergeChallenge markerTranscript
              @?= 511352225475574549627861119520029350015937004143915133412497166847319787206
            ownershipProofBatchMergeChallenge multiProof
              @?= 25168615990545306024971660901831754687099805661150605711399580878569654845810
        , testCase "S2/S3 nonzero map and suffix separation are exact" $ do
            let nz raw = 1 + raw `B.modInteger` (blsScalarFieldOrder - 1)
                proof1 = distinctFixtureProof (head distinctFixtures)
                domain = "ROOT-OWNERSHIP-POK-BATCH-v1"
                expected = ownershipProofBatchMergeChallenge proof1
                hashWith bytes = nz (B.byteStringToInteger BigEndian (B.blake2b_256 bytes))
            fmap nz [0, 1, blsScalarFieldOrder - 2, blsScalarFieldOrder - 1, blsScalarFieldOrder, 2 * blsScalarFieldOrder - 3]
              @?= [1, 2, blsScalarFieldOrder - 1, 1, 2, blsScalarFieldOrder - 1]
            expected @?= hashWith (domain <> proof1 <> B.consByteString 1 B.emptyByteString)
            forM_
              [ hashWith (domain <> proof1)
              , hashWith (domain <> B.consByteString 1 B.emptyByteString <> proof1)
              , hashWith (domain <> proof1 <> B.consByteString 0 B.emptyByteString)
              , hashWith (domain <> proof1 <> B.consByteString 2 B.emptyByteString)
              ] $ \mutated -> assertBool "mutated merge domain unexpectedly matched" (mutated /= expected)
        , testCase "VK coherence gate: IC1/K2/gamma and pairing bases are nonidentity" $ do
            let destinationParsed = parseVerifyingKeyBatch destinationVk
                multiParsed = parseVerifyingKey multiVk
                checkGate label ic1 k2 gamma = do
                  let identityG1 = 0 `B.bls12_381_G1_scalarMul` ic1
                      identityG2 = 0 `B.bls12_381_G2_scalarMul` gamma
                      identityMl = B.bls12_381_millerLoop identityG1 gamma
                  assertBool (label <> " IC1 is identity")
                    (B.bls12_381_G1_compress ic1 /= B.bls12_381_G1_compress identityG1)
                  assertBool (label <> " K2 is identity")
                    (B.bls12_381_G1_compress k2 /= B.bls12_381_G1_compress identityG1)
                  assertBool (label <> " gamma is identity")
                    (B.bls12_381_G2_compress gamma /= B.bls12_381_G2_compress identityG2)
                  assertBool (label <> " e(IC1,gamma) is identity") $
                    not (B.bls12_381_finalVerify (B.bls12_381_millerLoop ic1 gamma) identityMl)
                  assertBool (label <> " e(K2,gamma) is identity") $
                    not (B.bls12_381_finalVerify (B.bls12_381_millerLoop k2 gamma) identityMl)
            checkGate "destination" (parsedBatchIc1 destinationParsed) (parsedBatchK2 destinationParsed) (parsedBatchGamma destinationParsed)
            checkGate "Multi" (parsedIc1 multiParsed) (parsedK2 multiParsed) (parsedGamma multiParsed)
        , testCase "S4 every A/B/C/D/PoK byte class at every N=1..8 changes s" $ do
            forM_ [1 .. 8] $ \inputCount -> do
              let proofs = fmap distinctFixtureProof (take inputCount distinctFixtures)
                  original = ownershipProofBatchMergeChallenge (mconcat proofs)
              forM_ [0 .. inputCount - 1] $ \position ->
                forM_ [0, 48, 144, 192, 288] $ \offset ->
                  assertBool "component mutation left s unchanged" $
                    ownershipProofBatchMergeChallenge
                      (mconcat (replaceAt position (flipBitAt offset (proofs !! position)) proofs))
                      /= original
        , testCase "A1 old Groth/PoK conjunction equals merged Miller product N=1..8" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
            forM_ [1 .. 8] $ \inputCount -> do
              let fixtures = take inputCount distinctFixtures
                  proofs = fmap distinctFixtureProof fixtures
                  r = ownershipProofBatchChallenge (mconcat proofs)
                  s = ownershipProofBatchMergeChallenge (mconcat proofs)
                  weights = batchPowers r inputCount
                  checks =
                    [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
                        parsed
                        (distinctFixtureProof fixture)
                        (distinctFixtureCredential fixture)
                        destinationAddressBytes
                    | fixture <- fixtures
                    ]
                  coefficientSum = sum weights `B.modInteger` blsScalarFieldOrder
                  foldedCommitment = foldWeightedG1 (zip weights (fmap batchCommittedProofCommitment checks))
                  foldedPok = foldWeightedG1 (zip weights (fmap batchCommittedProofPok checks))
                  foldedC = foldWeightedG1 (zip weights (fmap batchCommittedProofC checks))
                  foldedPub = foldScalarProducts (zip weights (fmap batchCommittedProofPub checks))
                  foldedECmt = foldScalarProducts (zip weights (fmap batchCommittedProofECmt checks))
                  foldedVkX = coefficientFirstVkX parsed coefficientSum foldedPub foldedECmt foldedCommitment
                  foldedGrothLhs =
                    foldl1 B.bls12_381_mulMlResult
                      [ B.bls12_381_millerLoop
                          (weight `B.bls12_381_G1_scalarMul` batchCommittedProofA check)
                          (batchCommittedProofB check)
                      | (weight, check) <- zip weights checks
                      ]
                  oldGroth = verifyCommittedProofGrothBatch parsed coefficientSum foldedGrothLhs foldedVkX foldedC
                  oldPok = verifyCommittedProofPokBatchWithBatchVK parsed foldedCommitment foldedPok
                  merged = verifyCommittedProofMergedBatchWithBatchVK parsed coefficientSum foldedGrothLhs foldedVkX foldedC foldedCommitment foldedPok s
                  (actualLhs, actualRhs) =
                    committedProofMergedBatchSidesWithBatchVK
                      parsed coefficientSum foldedGrothLhs foldedVkX foldedC foldedCommitment foldedPok s
                  batchAlpha =
                    if builtinBoolToBool (batchCoefficientUsesUnscaledAlpha coefficientSum)
                      then parsedBatchAlpha parsed
                      else coefficientSum `B.bls12_381_G1_scalarMul` parsedBatchAlpha parsed
                  oldGrothRhs =
                    B.bls12_381_millerLoop batchAlpha (parsedBatchBeta parsed)
                      `B.bls12_381_mulMlResult` B.bls12_381_millerLoop foldedVkX (parsedBatchGamma parsed)
                      `B.bls12_381_mulMlResult` B.bls12_381_millerLoop foldedC (parsedBatchDelta parsed)
                  expectedPokLhs =
                    foldl1 B.bls12_381_mulMlResult
                      [ B.bls12_381_millerLoop
                          ((s * weight `B.modInteger` blsScalarFieldOrder) `B.bls12_381_G1_scalarMul` batchCommittedProofPok check)
                          (parsedBatchCkG parsed)
                      | (weight, check) <- zip weights checks
                      ]
                  expectedPokRhs =
                    foldl1 B.bls12_381_mulMlResult
                      [ B.bls12_381_millerLoop
                          ( B.bls12_381_G1_neg
                              ((s * weight `B.modInteger` blsScalarFieldOrder) `B.bls12_381_G1_scalarMul` batchCommittedProofCommitment check)
                          )
                          (parsedBatchCkGSN parsed)
                      | (weight, check) <- zip weights checks
                      ]
                  expectedLhs = foldedGrothLhs `B.bls12_381_mulMlResult` expectedPokLhs
                  expectedRhs = oldGrothRhs `B.bls12_381_mulMlResult` expectedPokRhs
              oldGroth @?= True
              oldPok @?= True
              merged @?= (oldGroth && oldPok)
              assertBool "actual merged LHS differs from independent per-row oracle"
                (B.bls12_381_finalVerify actualLhs expectedLhs)
              assertBool "actual merged RHS differs from independent per-row oracle"
                (B.bls12_381_finalVerify actualRhs expectedRhs)
        , testCase "A3/F1 terminal s-fold equals per-row s*w fold for N=1..8" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
            forM_ [1 .. 8] $ \inputCount -> do
              let fixtures = take inputCount distinctFixtures
                  proofs = fmap distinctFixtureProof fixtures
                  r = ownershipProofBatchChallenge (mconcat proofs)
                  productionS = ownershipProofBatchMergeChallenge (mconcat proofs)
                  weights = batchPowers r inputCount
                  checks =
                    [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok
                        parsed
                        (distinctFixtureProof fixture)
                        (distinctFixtureCredential fixture)
                        destinationAddressBytes
                    | fixture <- fixtures
                    ]
                  commitments = fmap batchCommittedProofCommitment checks
                  poks = fmap batchCommittedProofPok checks
              forM_ [1, blsScalarFieldOrder - 1, productionS] $ \s -> do
                let terminalD = s `B.bls12_381_G1_scalarMul` foldWeightedG1 (zip weights commitments)
                    perRowD = foldWeightedG1 (zip (fmap (\w -> s * w `B.modInteger` blsScalarFieldOrder) weights) commitments)
                    terminalP = s `B.bls12_381_G1_scalarMul` foldWeightedG1 (zip weights poks)
                    perRowP = foldWeightedG1 (zip (fmap (\w -> s * w `B.modInteger` blsScalarFieldOrder) weights) poks)
                B.bls12_381_G1_compress terminalD @?= B.bls12_381_G1_compress perRowD
                B.bls12_381_G1_compress terminalP @?= B.bls12_381_G1_compress perRowP
        , testCase "A4/F2 merged helper preserves unscaled Groth D and scales only PoK D/P" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                fixture = head distinctFixtures
                proof1 = distinctFixtureProof fixture
                s = ownershipProofBatchMergeChallenge proof1
            case verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok parsed proof1 (distinctFixtureCredential fixture) destinationAddressBytes of
              CommittedProofCheck commitment pok a b c vkX -> do
                let grothLhs = B.bls12_381_millerLoop a b
                assertBool "old Groth equation rejected fixture" (verifyCommittedProofGrothBatch parsed 1 grothLhs vkX c)
                assertBool "old PoK equation rejected fixture" (verifyCommittedProofPokBatchWithBatchVK parsed commitment pok)
                assertBool "merged equation rejected fixture"
                  (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX c commitment pok s)
                B.bls12_381_G1_compress ((1 + blsScalarFieldOrder) `B.bls12_381_G1_scalarMul` commitment)
                  @?= B.bls12_381_G1_compress (1 `B.bls12_381_G1_scalarMul` commitment)
                assertBool "X4 swapped commitment bases unexpectedly verified" $
                  not $
                    B.bls12_381_finalVerify
                      (B.bls12_381_millerLoop pok (parsedBatchCkGSN parsed))
                      (B.bls12_381_millerLoop (B.bls12_381_G1_neg commitment) (parsedBatchCkG parsed))
                assertBool "X4 wrong commitment sign unexpectedly verified" $
                  not $
                    B.bls12_381_finalVerify
                      (B.bls12_381_millerLoop pok (parsedBatchCkG parsed))
                      (B.bls12_381_millerLoop commitment (parsedBatchCkGSN parsed))
                let pokLhs = B.bls12_381_millerLoop pok (parsedBatchCkG parsed)
                    pokRhs = B.bls12_381_millerLoop (B.bls12_381_G1_neg commitment) (parsedBatchCkGSN parsed)
                    identity = 0 `B.bls12_381_G1_scalarMul` commitment
                    identityMl = B.bls12_381_millerLoop identity (parsedBatchCkG parsed)
                assertBool "X4 P/D point swap unexpectedly verified" $
                  not $
                    B.bls12_381_finalVerify
                      (B.bls12_381_millerLoop commitment (parsedBatchCkG parsed))
                      (B.bls12_381_millerLoop (B.bls12_381_G1_neg pok) (parsedBatchCkGSN parsed))
                assertBool "X4 omitted PoK Miller loop unexpectedly verified" $
                  not (B.bls12_381_finalVerify identityMl pokRhs)
                assertBool "X4 doubled one PoK side unexpectedly verified" $
                  not (B.bls12_381_finalVerify (pokLhs `B.bls12_381_mulMlResult` pokLhs) pokRhs)
                let wrongVkX =
                      vkX
                        `B.bls12_381_G1_add` ((s - 1) `B.bls12_381_G1_scalarMul` commitment)
                    omittedD = vkX `B.bls12_381_G1_add` B.bls12_381_G1_neg commitment
                    doubledD = vkX `B.bls12_381_G1_add` commitment
                assertBool "scaled D was incorrectly accepted in Groth vkX"
                  (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs wrongVkX c commitment pok s))
                assertBool "omitted Groth D was incorrectly accepted"
                  (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs omittedD c commitment pok s))
                assertBool "D plus D_s/doubled Groth D was incorrectly accepted"
                  (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs doubledD c commitment pok s))
        , testCase "N2/R1/R2 valid equations accept every s; independent and paired errors reject" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                fixture = head distinctFixtures
                proof1 = distinctFixtureProof fixture
                productionS = ownershipProofBatchMergeChallenge proof1
            case verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok parsed proof1 (distinctFixtureCredential fixture) destinationAddressBytes of
              CommittedProofCheck commitment pok a b c vkX -> do
                let grothLhs = B.bls12_381_millerLoop a b
                    tweakPoint scalar point = point `B.bls12_381_G1_add` (scalar `B.bls12_381_G1_scalarMul` parsedBatchIc0 parsed)
                forM_ [1, blsScalarFieldOrder - 1, productionS] $ \s ->
                  assertBool "valid equations depend on s"
                    (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX c commitment pok s)
                let alternateS =
                      1
                        + B.byteStringToInteger
                            BigEndian
                            ( B.blake2b_256
                                ( "ROOT-OWNERSHIP-POK-BATCH-v1"
                                    <> proof1
                                    <> B.consByteString 2 B.emptyByteString
                                )
                            )
                          `B.modInteger` (blsScalarFieldOrder - 1)
                assertBool "R1 alternate suffix must derive a different s" (alternateS /= productionS)
                assertBool "R1 valid proof rejected under alternate suffix/domain s"
                  (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX c commitment pok alternateS)
                forM_ [1 .. 8] $ \scalar -> do
                  let changedC = tweakPoint scalar c
                      changedPok = tweakPoint (scalar + 9) pok
                  assertBool "Groth-only error accepted"
                    (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX changedC commitment pok productionS))
                  assertBool "PoK-only error accepted"
                    (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX c commitment changedPok productionS))
                  assertBool "paired Groth/PoK error accepted"
                    (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX changedC commitment changedPok productionS))
                let staleS = ownershipProofBatchMergeChallenge (distinctFixtureProof (distinctFixtures !! 1))
                    changedC = tweakPoint 17 c
                assertBool "R2 fixture must use a different stale s" (staleS /= productionS)
                assertBool "invalid proof accepted with stale s"
                  (not (verifyCommittedProofMergedBatchWithBatchVK parsed 1 grothLhs vkX changedC commitment pok staleS))
        , testCase "X1 paired valid-subgroup Groth/PoK corpus covers every position N=1..8" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                corpusCount :: Int
                corpusCount = sum [4 * inputCount | inputCount <- [1 .. 8]]
            corpusCount @?= 144
            forM_ [1 .. 8] $ \inputCount -> do
              let fixtures = take inputCount distinctFixtures
                  proofs = fmap distinctFixtureProof fixtures
                  originalS = ownershipProofBatchMergeChallenge (mconcat proofs)
              forM_ [0 .. inputCount - 1] $ \position ->
                forM_ [(cChoice, pChoice) | cChoice <- [1, 2], pChoice <- [3, 4]] $ \(cChoice, pChoice) -> do
                  let originalProof = proofs !! position
                      donorC = distinctFixtureProof (distinctFixtures !! ((position + cChoice) `mod` length distinctFixtures))
                      donorPok = distinctFixtureProof (distinctFixtures !! ((position + pChoice) `mod` length distinctFixtures))
                      changedProof =
                        replaceProofSlice 288 48 (B.sliceByteString 288 48 donorPok) $
                          replaceProofSlice 144 48 (B.sliceByteString 144 48 donorC) originalProof
                      changedProofs = replaceAt position changedProof proofs
                      changedTranscript = mconcat changedProofs
                      r = ownershipProofBatchChallenge changedTranscript
                      s = ownershipProofBatchMergeChallenge changedTranscript
                      weights = batchPowers r inputCount
                      checks =
                        [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed changed (distinctFixtureCredential fixture) destinationAddressBytes
                        | (fixture, changed) <- zip fixtures changedProofs
                        ]
                      coefficientSum = sum weights `B.modInteger` blsScalarFieldOrder
                      foldedCommitment = foldWeightedG1 (zip weights (fmap batchCommittedProofCommitment checks))
                      foldedPok = foldWeightedG1 (zip weights (fmap batchCommittedProofPok checks))
                      foldedC = foldWeightedG1 (zip weights (fmap batchCommittedProofC checks))
                      foldedPub = foldScalarProducts (zip weights (fmap batchCommittedProofPub checks))
                      foldedECmt = foldScalarProducts (zip weights (fmap batchCommittedProofECmt checks))
                      foldedVkX = coefficientFirstVkX parsed coefficientSum foldedPub foldedECmt foldedCommitment
                      foldedGrothLhs =
                        foldl1 B.bls12_381_mulMlResult
                          [ B.bls12_381_millerLoop
                              (weight `B.bls12_381_G1_scalarMul` batchCommittedProofA check)
                              (batchCommittedProofB check)
                          | (weight, check) <- zip weights checks
                          ]
                      oldGroth = verifyCommittedProofGrothBatch parsed coefficientSum foldedGrothLhs foldedVkX foldedC
                      oldPok = verifyCommittedProofPokBatchWithBatchVK parsed foldedCommitment foldedPok
                      merged = verifyCommittedProofMergedBatchWithBatchVK parsed coefficientSum foldedGrothLhs foldedVkX foldedC foldedCommitment foldedPok s
                      changedContext = distinctV2Context fixtures changedProofs
                  assertBool "X1 serialized mutation did not recompute s" (s /= originalS)
                  oldGroth @?= False
                  oldPok @?= False
                  merged @?= False
                  oldSerialized <- safeBool (runReclaimGlobal destinationVk changedContext)
                  v2Serialized <- safeBool (runReclaimGlobalV2 destinationVk changedContext)
                  oldSerialized @?= False
                  v2Serialized @?= oldSerialized
        , testCase "X2/X3 target-group oracle demonstrates cancellation and forced-zero failure" $ do
            let parsed = parseVerifyingKeyBatch destinationVk
                point = parsedBatchIc1 parsed
                gamma = parsedBatchGamma parsed
                identity = 0 `B.bls12_381_G1_scalarMul` point
                oneMl = B.bls12_381_millerLoop identity gamma
                pMl = B.bls12_381_millerLoop point gamma
                s = 7
                sPMl = B.bls12_381_millerLoop (s `B.bls12_381_G1_scalarMul` point) gamma
                oldGroth = B.bls12_381_finalVerify oneMl sPMl
                oldPok = B.bls12_381_finalVerify pMl oneMl
                mergedCancellation =
                  B.bls12_381_finalVerify
                    (oneMl `B.bls12_381_mulMlResult` sPMl)
                    (sPMl `B.bls12_381_mulMlResult` oneMl)
                forcedZero =
                  B.bls12_381_finalVerify
                    (oneMl `B.bls12_381_mulMlResult` B.bls12_381_millerLoop identity gamma)
                    (oneMl `B.bls12_381_mulMlResult` oneMl)
                ignoredS =
                  B.bls12_381_finalVerify
                    (oneMl `B.bls12_381_mulMlResult` pMl)
                    (sPMl `B.bls12_381_mulMlResult` oneMl)
            oldGroth @?= False
            oldPok @?= False
            mergedCancellation @?= True
            forcedZero @?= True
            ignoredS @?= False
        , testGroup "A1/G1/P1/P2 distinct N=1..8 differential"
            [ testCase ("N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                    proofs = fmap distinctFixtureProof fixtures
                    parsed = parseVerifyingKeyBatch destinationVk
                    positiveContext = distinctV2Context fixtures proofs
                oldPositive <- safeBool (runReclaimGlobal destinationVk positiveContext)
                v2Positive <- safeBool (runReclaimGlobalV2 destinationVk positiveContext)
                oldPositive @?= True
                v2Positive @?= oldPositive
                forM_ [0 .. inputCount - 1] $ \position ->
                  forM_
                    [ ("A", 0)
                    , ("B", 48)
                    , ("C", 144)
                    , ("D", 192)
                    , ("PoK", 288)
                    ] $ \(label, offset) -> do
                      let changed = flipBitAt offset (proofs !! position)
                          negativeContext = distinctV2Context fixtures (replaceAt position changed proofs)
                      oldNegative <- safeBool (runReclaimGlobal destinationVk negativeContext)
                      v2Negative <- safeBool (runReclaimGlobalV2 destinationVk negativeContext)
                      assertBool (label <> " mutation unexpectedly accepted by old N=" <> show inputCount) (not oldNegative)
                      assertBool (label <> " mutation unexpectedly accepted by V2 N=" <> show inputCount) (not v2Negative)
                      v2Negative @?= oldNegative
                forM_ [0 .. inputCount - 1] $ \position -> do
                  let donorProof = distinctFixtureProof (distinctFixtures !! ((position + 1) `mod` length distinctFixtures))
                      originalProof = proofs !! position
                      validSubgroupMutations =
                        [ ( "A-valid-subgroup"
                          , replaceProofSlice 0 48 (B.sliceByteString 0 48 donorProof) originalProof
                          , True
                          )
                        , ( "B-valid-subgroup"
                          , replaceProofSlice 48 96 (B.sliceByteString 48 96 donorProof) originalProof
                          , True
                          )
                        , ( "C-valid-subgroup"
                          , replaceProofSlice 144 48 (B.sliceByteString 144 48 donorProof) originalProof
                          , True
                          )
                        , ( "D-valid-subgroup"
                          , replaceProofSlice 192 96 (B.sliceByteString 192 96 donorProof) originalProof
                          , False
                          )
                        , ( "PoK-valid-subgroup"
                          , replaceProofSlice 288 48 (B.sliceByteString 288 48 donorProof) originalProof
                          , False
                          )
                        ]
                  forM_ validSubgroupMutations $ \(label, changed, preservesPok) -> do
                    let negativeContext = distinctV2Context fixtures (replaceAt position changed proofs)
                    oldNegative <- safeBool (runReclaimGlobal destinationVk negativeContext)
                    v2Negative <- safeBool (runReclaimGlobalV2 destinationVk negativeContext)
                    assertBool (label <> " unexpectedly accepted by old N=" <> show inputCount) (not oldNegative)
                    assertBool (label <> " unexpectedly accepted by V2 N=" <> show inputCount) (not v2Negative)
                    v2Negative @?= oldNegative
                    if preservesPok
                      then
                        case verifyOwnershipDestinationWithParsedBatchVKLegacyKnown28NoPok parsed changed (distinctFixtureCredential (fixtures !! position)) destinationAddressBytes of
                          CommittedProofCheck commitment pok a b c vkX -> do
                            assertBool (label <> " changed old PoK")
                              (verifyCommittedProofPokBatchWithBatchVK parsed commitment pok)
                            assertBool (label <> " did not fail old Groth")
                              (not (verifyCommittedProofGrothBatch parsed 1 (B.bls12_381_millerLoop a b) vkX c))
                      else pure ()
            | inputCount <- [1 .. 8]
            ]
        , testGroup "S6/G2/G3/R3 authenticated statement/order differential"
            [ testCase ("N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                    proofs = fmap distinctFixtureProof fixtures
                    transcriptS = ownershipProofBatchMergeChallenge (mconcat proofs)
                forM_ [0 .. inputCount - 1] $ \position -> do
                  let fixture = fixtures !! position
                      changedFixture =
                        fixture
                          { distinctFixtureCredential = flipBitAt 0 (distinctFixtureCredential fixture)
                          }
                      changedContext = distinctV2Context (replaceAt position changedFixture fixtures) proofs
                  ownershipProofBatchMergeChallenge (mconcat proofs) @?= transcriptS
                  oldNegative <- safeBool (runReclaimGlobal destinationVk changedContext)
                  v2Negative <- safeBool (runReclaimGlobalV2 destinationVk changedContext)
                  oldNegative @?= False
                  v2Negative @?= oldNegative
                  let changedDestinationContext =
                        distinctV2ContextWithOutputs
                          fixtures
                          proofs
                          (replaceAt position changedSingleDestinationOutput (replicate inputCount singleDestinationOutput))
                  oldDestinationNegative <- safeBool (runReclaimGlobal destinationVk changedDestinationContext)
                  v2DestinationNegative <- safeBool (runReclaimGlobalV2 destinationVk changedDestinationContext)
                  oldDestinationNegative @?= False
                  v2DestinationNegative @?= oldDestinationNegative
                if inputCount >= 2
                  then do
                    let swappedProofs = swapFirstTwo proofs
                        inconsistent = distinctV2Context fixtures swappedProofs
                        consistent = distinctV2Context (swapFirstTwo fixtures) swappedProofs
                    oldInconsistent <- safeBool (runReclaimGlobal destinationVk inconsistent)
                    v2Inconsistent <- safeBool (runReclaimGlobalV2 destinationVk inconsistent)
                    oldConsistent <- safeBool (runReclaimGlobal destinationVk consistent)
                    v2Consistent <- safeBool (runReclaimGlobalV2 destinationVk consistent)
                    oldInconsistent @?= False
                    v2Inconsistent @?= oldInconsistent
                    oldConsistent @?= True
                    v2Consistent @?= oldConsistent
                  else pure ()
            | inputCount <- [1 .. 8]
            ]
        , testCase "S7 malformed marker chains and proof lengths match production rejection" $ do
            let malformedProofs =
                  [ V2Global.reclaimSameAsPreviousProof
                  , B.sliceByteString 0 335 destinationProof
                  , destinationProof <> B.consByteString 0 B.emptyByteString
                  ]
            forM_ malformedProofs $ \malformedProof -> do
              let ctx = reclaimGlobalContext malformedProof 0 [reclaimBaseInput] [paramInput]
              oldNegative <- safeBool (runReclaimGlobal destinationVk ctx)
              v2Negative <- safeBool (runReclaimGlobalV2 destinationVk ctx)
              oldNegative @?= False
              v2Negative @?= oldNegative
            let markerContexts =
                  [ reclaimGlobalContextWithOutputs
                      [destinationProof, V2Global.reclaimSameAsPreviousProof]
                      0
                      [reclaimBaseInput, differentOwnerReclaimBaseInput]
                      [paramInput]
                      [singleDestinationOutput, singleDestinationOutput]
                  , reclaimGlobalContextWithOutputs
                      [destinationProof, V2Global.reclaimSameAsPreviousProof]
                      0
                      [reclaimBaseInput, secondReclaimBaseInput]
                      [paramInput]
                      [singleDestinationOutput, changedSingleDestinationOutput]
                  ]
            forM_ markerContexts $ \ctx -> do
              oldNegative <- safeBool (runReclaimGlobal destinationVk ctx)
              v2Negative <- safeBool (runReclaimGlobalV2 destinationVk ctx)
              oldNegative @?= False
              v2Negative @?= oldNegative
        , testCase "N1 broad serialized negatives replay against V2" $ do
            let negativeContexts =
                  [ reclaimGlobalContext destinationProof 0
                      [reclaimBaseInputWithDatum (ReclaimBaseDatum wrongPaymentKeyHash)]
                      [paramInput]
                  , reclaimGlobalContextWithOutputs [destinationProof] 0 [reclaimBaseInput] [paramInput] [changedSingleDestinationOutput]
                  , reclaimGlobalContextWithOutputs [destinationProof] 0 [reclaimBaseInput] [paramInput] [underpaidSingleDestinationOutput]
                  , reclaimGlobalSpendingContext destinationProof 0 [reclaimBaseInput] [paramInput]
                  , reclaimGlobalMintingContext destinationProof 0 [reclaimBaseInput] [paramInput]
                  , reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInputWithValue mempty]
                  , reclaimGlobalContext (proofWithCommitmentY blsBaseFieldOrder destinationProof) 0 [reclaimBaseInput] [paramInput]
                  ]
            forM_ negativeContexts $ \ctx -> do
              oldNegative <- safeBool (runReclaimGlobal destinationVk ctx)
              v2Negative <- safeBool (runReclaimGlobalV2 destinationVk ctx)
              oldNegative @?= False
              v2Negative @?= oldNegative
        , let malformedCommitment = B.consByteString 127 (bytesToBuiltin (replicate 95 255))
              pointMutations =
                [ ("identity A", replaceProofSlice 0 48 (compressedIdentity 48))
                , ("identity B", replaceProofSlice 48 96 (compressedIdentity 96))
                , ("identity C", replaceProofSlice 144 48 (compressedIdentity 48))
                , ("identity D", replaceProofSlice 192 96 uncompressedCommitmentIdentity)
                , ("identity PoK", replaceProofSlice 288 48 (compressedIdentity 48))
                , ("malformed A", replaceProofSlice 0 48 (malformedCompressedPoint 48))
                , ("malformed B", replaceProofSlice 48 96 (malformedCompressedPoint 96))
                , ("malformed C", replaceProofSlice 144 48 (malformedCompressedPoint 48))
                , ("malformed D", replaceProofSlice 192 96 malformedCommitment)
                , ("malformed PoK", replaceProofSlice 288 48 (malformedCompressedPoint 48))
                ]
           in testGroup "P3/N1 V2 identity, malformed, and VK-length differential"
                [ testCase "N=1 legacy parser" $ do
                    forM_ pointMutations $ \(label, mutate) -> do
                      let ctx = reclaimGlobalContext (mutate destinationProof) 0 [reclaimBaseInput] [paramInput]
                      oldNegative <- safeBool (runReclaimGlobal destinationVk ctx)
                      v2Negative <- safeBool (runReclaimGlobalV2 destinationVk ctx)
                      assertBool (label <> " accepted by old N=1") (not oldNegative)
                      assertBool (label <> " accepted by V2 N=1") (not v2Negative)
                , testCase "N=2 second-distinct parser" $ do
                    let firstFixture = head distinctFixtures
                        secondFixture = distinctFixtures !! 1
                        fixtures = [firstFixture, secondFixture]
                        proofs = fmap distinctFixtureProof fixtures
                    forM_ pointMutations $ \(label, mutate) -> do
                      let ctx = distinctV2Context fixtures [head proofs, mutate (proofs !! 1)]
                      oldNegative <- safeBool (runReclaimGlobal destinationVk ctx)
                      v2Negative <- safeBool (runReclaimGlobalV2 destinationVk ctx)
                      assertBool (label <> " accepted by old N=2") (not oldNegative)
                      assertBool (label <> " accepted by V2 N=2") (not v2Negative)
                , testCase "671/673-byte VKs" $ do
                    let ctx = reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInput]
                        malformedVks =
                          [ B.sliceByteString 0 671 destinationVk
                          , destinationVk <> B.consByteString 0 B.emptyByteString
                          ]
                    forM_ malformedVks $ \malformedVk -> do
                      oldNegative <- safeBool (runReclaimGlobal malformedVk ctx)
                      v2Negative <- safeBool (runReclaimGlobalV2 malformedVk ctx)
                      oldNegative @?= False
                      v2Negative @?= oldNegative
                ]
        , testGroup "A2 repeated markers N=1,2,5,35"
            [ testCase ("N=" <> show inputCount) $ do
                let inputs =
                      [ reclaimBaseInputAt
                          (B.consByteString (toInteger index) "v2-repeat")
                          (toInteger index)
                      | index <- [0 :: Int .. inputCount - 1]
                      ]
                    markerProofs = destinationProof : replicate (inputCount - 1) V2Global.reclaimSameAsPreviousProof
                    expandedProofs = replicate inputCount destinationProof
                    markerTranscript = V2Global.reclaimProofBytesConcat (proofSlotData markerProofs)
                    expandedTranscript = V2Global.reclaimProofBytesConcat (proofSlotData expandedProofs)
                    markerContext = reclaimGlobalContextWithOutputs markerProofs 0 inputs [paramInput] (replicate inputCount singleDestinationOutput)
                    expandedContext = reclaimGlobalContextWithOutputs expandedProofs 0 inputs [paramInput] (replicate inputCount singleDestinationOutput)
                markerTranscript @?= expandedTranscript
                ownershipProofBatchMergeChallenge markerTranscript @?= ownershipProofBatchMergeChallenge expandedTranscript
                oldMarker <- safeBool (runReclaimGlobal destinationVk markerContext)
                v2Marker <- safeBool (runReclaimGlobalV2 destinationVk markerContext)
                v2Expanded <- safeBool (runReclaimGlobalV2 destinationVk expandedContext)
                oldMarker @?= True
                v2Marker @?= oldMarker
                v2Expanded @?= v2Marker
            | inputCount <- [1, 2, 5, 35]
            ]
        , testCase "A2 mixed cached/distinct chain matches expanded decisions" $ do
            let firstFixture = head distinctFixtures
                secondFixture = distinctFixtures !! 1
                fixtures = [firstFixture, firstFixture, secondFixture, secondFixture]
                markerProofs =
                  [ distinctFixtureProof firstFixture
                  , V2Global.reclaimSameAsPreviousProof
                  , distinctFixtureProof secondFixture
                  , V2Global.reclaimSameAsPreviousProof
                  ]
                expandedProofs = fmap distinctFixtureProof fixtures
                markerTranscript = V2Global.reclaimProofBytesConcat (proofSlotData markerProofs)
                expandedTranscript = V2Global.reclaimProofBytesConcat (proofSlotData expandedProofs)
                markerContext = distinctV2Context fixtures markerProofs
                expandedContext = distinctV2Context fixtures expandedProofs
            markerTranscript @?= expandedTranscript
            ownershipProofBatchMergeChallenge markerTranscript @?= ownershipProofBatchMergeChallenge expandedTranscript
            oldMarker <- safeBool (runReclaimGlobal destinationVk markerContext)
            v2Marker <- safeBool (runReclaimGlobalV2 destinationVk markerContext)
            v2Expanded <- safeBool (runReclaimGlobalV2 destinationVk expandedContext)
            oldMarker @?= True
            v2Marker @?= oldMarker
            v2Expanded @?= v2Marker
        , testCase "M3/M4 Multi paired corpus and eager-vkX wiring mutations reject" $ do
            let parsed = parseVerifyingKey multiVk
                s = ownershipProofBatchMergeChallenge multiProof
            case groth16VerifyCommittedParsedNoPok parsed (Proof multiProof) (Scalar multiPub) of
              CommittedProofCheck commitment pok a b c vkX -> do
                let grothLhs = B.bls12_381_millerLoop a b
                    merged currentVkX currentC currentCommitment currentPok =
                      verifyCommittedProofMergedWithVK parsed grothLhs currentVkX currentC currentCommitment currentPok s
                    oldGroth currentVkX currentC =
                      B.bls12_381_finalVerify
                        grothLhs
                        ( parsedAlphaBeta parsed
                            `B.bls12_381_mulMlResult` B.bls12_381_millerLoop currentVkX (parsedGamma parsed)
                            `B.bls12_381_mulMlResult` B.bls12_381_millerLoop currentC (parsedDelta parsed)
                        )
                    delta = parsedIc0 parsed
                    (actualLhs, actualRhs) = committedProofMergedSidesWithVK parsed grothLhs vkX c commitment pok s
                    expectedOldGrothRhs =
                      parsedAlphaBeta parsed
                        `B.bls12_381_mulMlResult` B.bls12_381_millerLoop vkX (parsedGamma parsed)
                        `B.bls12_381_mulMlResult` B.bls12_381_millerLoop c (parsedDelta parsed)
                    expectedLhs =
                      grothLhs
                        `B.bls12_381_mulMlResult` B.bls12_381_millerLoop (s `B.bls12_381_G1_scalarMul` pok) (parsedCkG parsed)
                    expectedRhs =
                      expectedOldGrothRhs
                        `B.bls12_381_mulMlResult` B.bls12_381_millerLoop
                          (B.bls12_381_G1_neg (s `B.bls12_381_G1_scalarMul` commitment))
                          (parsedCkGSN parsed)
                assertBool "M4 correct Multi merge rejected" (merged vkX c commitment pok)
                assertBool "M4 actual Multi LHS differs from independent oracle" (B.bls12_381_finalVerify actualLhs expectedLhs)
                assertBool "M4 actual Multi RHS differs from independent oracle" (B.bls12_381_finalVerify actualRhs expectedRhs)
                forM_ [(grothScalar, pokScalar) | grothScalar <- [1, 2], pokScalar <- [3, 4]] $ \(grothScalar, pokScalar) -> do
                  let changedC = c `B.bls12_381_G1_add` (grothScalar `B.bls12_381_G1_scalarMul` delta)
                      changedPok = pok `B.bls12_381_G1_add` (pokScalar `B.bls12_381_G1_scalarMul` delta)
                  assertBool "M3 old Groth unexpectedly accepted" (not (oldGroth vkX changedC))
                  assertBool "M3 old PoK unexpectedly accepted" (not (verifyCommittedProofPokBatch parsed commitment changedPok))
                  assertBool "M3 paired Multi error accepted" (not (merged vkX changedC commitment changedPok))
                let omittedD = vkX `B.bls12_381_G1_add` B.bls12_381_G1_neg commitment
                    doubledD = vkX `B.bls12_381_G1_add` commitment
                    scaledD = vkX `B.bls12_381_G1_add` ((s - 1) `B.bls12_381_G1_scalarMul` commitment)
                    swappedBases =
                      B.bls12_381_finalVerify
                        (B.bls12_381_millerLoop pok (parsedCkGSN parsed))
                        (B.bls12_381_millerLoop (B.bls12_381_G1_neg commitment) (parsedCkG parsed))
                assertBool "M4 omitted eager D accepted" (not (merged omittedD c commitment pok))
                assertBool "M4 doubled eager D accepted" (not (merged doubledD c commitment pok))
                assertBool "M4 substituted scaled D accepted" (not (merged scaledD c commitment pok))
                assertBool "M4 swapped ckG/ckGSN accepted" (not swappedBases)
        , testCase "M1-M3 Multi positive and component negatives match old validator" $ do
            let positiveContext =
                  reclaimGlobalMultiContext multiProof 0 0
                    [reclaimBaseInput, differentOwnerReclaimBaseInput]
                    [paramInput]
                    [exactDestinationOutput]
            oldPositive <- safeBool (runReclaimGlobalMulti multiVk positiveContext)
            v2Positive <- safeBool (runReclaimGlobalMultiV2 multiVk positiveContext)
            oldPositive @?= True
            v2Positive @?= oldPositive
            forM_
              [ ("A", 0)
              , ("B", 48)
              , ("C", 144)
              , ("D", 192)
              , ("PoK", 288)
              ] $ \(label, offset) -> do
                let changedContext =
                      reclaimGlobalMultiContext (flipBitAt offset multiProof) 0 0
                        [reclaimBaseInput, differentOwnerReclaimBaseInput]
                        [paramInput]
                        [exactDestinationOutput]
                oldNegative <- safeBool (runReclaimGlobalMulti multiVk changedContext)
                v2Negative <- safeBool (runReclaimGlobalMultiV2 multiVk changedContext)
                assertBool (label <> " Multi mutation accepted by old validator") (not oldNegative)
                assertBool (label <> " Multi mutation accepted by V2 validator") (not v2Negative)
                v2Negative @?= oldNegative
            let donorMutations =
                  [ ("C-valid-subgroup", replaceProofSlice 144 48 (B.sliceByteString 144 48 destinationProof) multiProof)
                  , ("D-valid-subgroup", replaceProofSlice 192 96 (B.sliceByteString 192 96 destinationProof) multiProof)
                  , ("PoK-valid-subgroup", replaceProofSlice 288 48 (B.sliceByteString 288 48 destinationProof) multiProof)
                  , ( "C+PoK-valid-subgroup"
                    , replaceProofSlice 288 48 (B.sliceByteString 288 48 destinationProof) $
                        replaceProofSlice 144 48 (B.sliceByteString 144 48 destinationProof) multiProof
                    )
                  ]
            forM_ donorMutations $ \(label, changedProof) -> do
              let changedContext =
                    reclaimGlobalMultiContext changedProof 0 0
                      [reclaimBaseInput, differentOwnerReclaimBaseInput]
                      [paramInput]
                      [exactDestinationOutput]
              oldNegative <- safeBool (runReclaimGlobalMulti multiVk changedContext)
              v2Negative <- safeBool (runReclaimGlobalMultiV2 multiVk changedContext)
              assertBool (label <> " accepted by old Multi") (not oldNegative)
              assertBool (label <> " accepted by V2 Multi") (not v2Negative)
              v2Negative @?= oldNegative
        , testCase "M2 Multi statement and destination negatives match old validator" $ do
            let negativeContexts =
                  [ reclaimGlobalMultiContext multiProof 0 0
                      [differentOwnerReclaimBaseInput, reclaimBaseInput]
                      [paramInput]
                      [exactDestinationOutput]
                  , reclaimGlobalMultiContext multiProof 0 0
                      [reclaimBaseInput, differentOwnerReclaimBaseInput]
                      [paramInput]
                      [changedDestinationOutput]
                  , reclaimGlobalMultiContext multiProof 0 0
                      [reclaimBaseInput, differentOwnerReclaimBaseInput]
                      [paramInput]
                      [underpaidDestinationOutput]
                  , reclaimGlobalMultiContext multiProof 0 0
                      [reclaimBaseInput]
                      [paramInput]
                      [exactDestinationOutput]
                  , reclaimGlobalMultiContext multiProof 0 0
                      [reclaimBaseInput, thirdOwnerReclaimBaseInput]
                      [paramInput]
                      [exactDestinationOutput]
                  , reclaimGlobalMultiContext destinationProof 0 0
                      [reclaimBaseInput, differentOwnerReclaimBaseInput]
                      [paramInput]
                      [exactDestinationOutput]
                  ]
            forM_ negativeContexts $ \ctx -> do
              oldNegative <- safeBool (runReclaimGlobalMulti multiVk ctx)
              v2Negative <- safeBool (runReclaimGlobalMultiV2 multiVk ctx)
              oldNegative @?= False
              v2Negative @?= oldNegative
        ]
    , testGroup "Ownership.ReclaimGlobal"
        [ localOption (QC.QuickCheckTests 1000) $
            QC.testProperty "ledger-normalized Value coverage matches Value.leq in V1 and V2" $
              QC.forAll genLedgerValueCoverageCase valueCoverageDifferentialProperty
        , testCase "ledger-normalized Value coverage rejects a missing required native asset" $
            assertLedgerValueCoverage
              False
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)]), (policyA, [(tokenA, 1)])])
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)])])
        , testCase "ledger-normalized Value coverage rejects a quantity shortfall by one" $
            assertLedgerValueCoverage
              False
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)]), (policyA, [(tokenA, 5)])])
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)]), (policyA, [(tokenA, 4)])])
        , testCase "ledger-normalized Value coverage rejects the right total under the wrong policy" $
            assertLedgerValueCoverage
              False
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)]), (policyA, [(tokenA, 5)])])
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)]), (policyB, [(tokenA, 5)])])
        , testCase "ledger-normalized Value coverage allows positive extra paid assets" $
            assertLedgerValueCoverage
              True
              (ledgerValue [(V3.adaSymbol, [(V3.adaToken, 10000000)])])
              ( ledgerValue
                  [ (V3.adaSymbol, [(V3.adaToken, 10000000)])
                  , (policyB, [(tokenA, 9)])
                  ]
              )
        , testCase "preprod protocol-v11 snapshot release gate evaluates production paths" $ do
            loadedSnapshot <-
              loadProtocol11Snapshot protocol11SnapshotPath
            case loadedSnapshot of
              Left err -> assertFailure err
              Right snapshot -> do
                let globalScript =
                      compiledToProgram $
                        reclaimGlobalValidatorCode
                          `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramCurrencySymbol
                          `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef paramTokenName
                          `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef destinationVk
                    baseScript =
                      compiledToProgram $
                        reclaimBaseValidatorCode
                          `PlutusTx.unsafeApplyCode` PlutusTx.liftCodeDef (V3.toBuiltinData globalCredential)
                    (positiveSucceeded, positiveBudget, positiveLogsEmpty) =
                      evaluateCompiledScriptWith
                        (snapshotMachineParameters snapshot)
                        globalScript
                        (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInput])
                    (negativeSucceeded, negativeBudget, negativeLogsEmpty) =
                      evaluateCompiledScriptWith
                        (snapshotMachineParameters snapshot)
                        baseScript
                        (reclaimBaseContext (Just validBaseDatum) [])
                snapshotCanonicalProtocolParametersHash snapshot
                  @?= "e710abd050607fddc29d16a930bf222e465f053daed75ea4eebdac8134492bcb"
                snapshotPlutusV3ParameterCount snapshot @?= 350
                assertBool "replicateByte no-stake production path must succeed" positiveSucceeded
                assertBool "trace-stripped missing-withdrawal branch must fail" (not negativeSucceeded)
                assertBool "positive production path must emit no trace logs" positiveLogsEmpty
                assertBool "trace-stripped failure must emit no trace logs" negativeLogsEmpty
                putStrLn $
                  "V7 protocol-v11 gate: PASS; hash="
                    <> snapshotCanonicalProtocolParametersHash snapshot
                    <> "; entries=350; evaluator_entries="
                    <> show (snapshotEvaluatorParameterCount snapshot)
                    <> "; positive_ex_units="
                    <> renderExBudget positiveBudget
                    <> "; negative_ex_units="
                    <> renderExBudget negativeBudget
                    <> "; negative_logs=0"
        , testCase "protocol-v11 snapshot rejects missing, extra, reordered, and malformed model values" $ do
            decoded <- eitherDecode <$> BL.readFile protocol11SnapshotPath
            case decoded of
              Left err -> assertFailure err
              Right snapshotValue ->
                forM_
                  [ ("missing", mutatePlutusV3Model dropLast snapshotValue)
                  , ("extra", mutatePlutusV3Model (<> [Number 0]) snapshotValue)
                  , ("reordered", mutatePlutusV3Model swapFirstTwo snapshotValue)
                  , ("malformed", mutatePlutusV3Model replaceFirstMalformed snapshotValue)
                  ] $
                  \(label, mutatedSnapshot) ->
                    withEncodedSnapshot mutatedSnapshot $ \path -> do
                      result <- loadProtocol11Snapshot path
                      case result of
                        Left _ -> pure ()
                        Right _ -> assertFailure (label <> " cost-model mutation was accepted")
        , testCase "accepts one reclaim base input with its real proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= True
        , testGroup "V8 distinct-proof decision matrix N=1..8" $
            [ testCase ("N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                    proofs = fmap distinctFixtureProof fixtures
                    inputs =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "v8-distinct")
                          (toInteger index)
                          (ReclaimBaseDatum (distinctFixtureCredential fixture))
                      | (index, fixture) <- zip [0 :: Int ..] fixtures
                      ]
                    outputs = replicate inputCount singleDestinationOutput
                    runWith candidateProofs candidateOutputs =
                      safeBool $
                        runReclaimGlobal destinationVk $
                          reclaimGlobalContextWithOutputs
                            candidateProofs
                            0
                            inputs
                            [paramInput]
                            candidateOutputs

                positive <- runWith proofs outputs
                positive @?= True

                let tamperedProofs = init proofs <> [tamperProof (last proofs)]
                tampered <- runWith tamperedProofs outputs
                tampered @?= False

                redirected <-
                  runWith proofs (changedSingleDestinationOutput : drop 1 outputs)
                redirected @?= False

                if inputCount >= 2
                  then do
                    -- Proof order is the public-input order: swapping proof
                    -- slots while authenticated input datums stay fixed swaps
                    -- the proofs' pub values and must fail.
                    reordered <- runWith (swapFirstTwo proofs) outputs
                    reordered @?= False
                  else pure ()
            | inputCount <- [1 .. 8]
            ]
        , testGroup "O1/O2/O3 proof-public-input ordering N=2..8" $
            [ testCase ("N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                    proofs = fmap distinctFixtureProof fixtures
                    credentials = fmap distinctFixtureCredential fixtures
                    outputs = replicate inputCount singleDestinationOutput
                    mkInputs candidateCredentials =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "v8-order")
                          (toInteger index)
                          (ReclaimBaseDatum credential)
                      | (index, credential) <- zip [0 :: Int ..] candidateCredentials
                      ]
                    runWith candidateProofs candidateCredentials =
                      safeBool $
                        runReclaimGlobal destinationVk $
                          reclaimGlobalContextWithOutputs candidateProofs 0 (mkInputs candidateCredentials) [paramInput] outputs

                swappedPubs <- runWith proofs (swapFirstTwo credentials)
                assertBool "O1 swapped authenticated pub values accepted" (not swappedPubs)

                swappedProofs <- runWith (swapFirstTwo proofs) credentials
                assertBool "O2 swapped proof slots accepted" (not swappedProofs)

                consistentlySwapped <- runWith (swapFirstTwo proofs) (swapFirstTwo credentials)
                assertBool "O3 consistently swapped tuples rejected" consistentlySwapped
            | inputCount <- [2 .. 8]
            ]
        , testGroup "C1-C5 position-complete mutation matrix N=1..8" $
            [ testCase ("N=" <> show inputCount) $ do
                let fixtures = take inputCount distinctFixtures
                    proofs = fmap distinctFixtureProof fixtures
                    credentials = fmap distinctFixtureCredential fixtures
                    outputs = replicate inputCount singleDestinationOutput
                    donorProof = distinctFixtureProof (distinctFixtures !! inputCount)
                    mkInputs candidateCredentials =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "v8-mutation")
                          (toInteger index)
                          (ReclaimBaseDatum credential)
                      | (index, credential) <- zip [0 :: Int ..] candidateCredentials
                      ]
                    runWith candidateProofs candidateCredentials candidateOutputs =
                      safeBool $
                        runReclaimGlobal destinationVk $
                          reclaimGlobalContextWithOutputs candidateProofs 0 (mkInputs candidateCredentials) [paramInput] candidateOutputs
                    oneBitDestination = pubKeyOutput (flipFirstBit destinationPaymentKeyHash) reclaimValue
                    componentMutations =
                      [ ("A", 0, 48)
                      , ("B", 48, 96)
                      , ("C", 144, 48)
                      ]

                forM_ [0 .. inputCount - 1] $ \position -> do
                  changedCredential <-
                    runWith
                      proofs
                      (replaceAt position (flipFirstBit (credentials !! position)) credentials)
                      outputs
                  assertBool ("C1 credential bit at position " <> show position <> " accepted") (not changedCredential)

                  changedDestination <-
                    runWith proofs credentials (replaceAt position oneBitDestination outputs)
                  assertBool ("C2 destination byte at position " <> show position <> " accepted") (not changedDestination)

                  changedCommitment <-
                    runWith
                      (replaceAt position (flipBitAt 193 (proofs !! position)) proofs)
                      credentials
                      outputs
                  assertBool ("C3 commitment byte at position " <> show position <> " accepted") (not changedCommitment)

                  forM_ componentMutations $ \(component, offset, width) -> do
                    changedComponent <-
                      runWith
                        (replaceAt position (replaceProofComponentFrom offset width donorProof (proofs !! position)) proofs)
                        credentials
                        outputs
                    assertBool ("C4 " <> component <> " at position " <> show position <> " accepted") (not changedComponent)

                  changedPok <-
                    runWith
                      (replaceAt position (replaceProofComponentFrom 288 48 donorProof (proofs !! position)) proofs)
                      credentials
                      outputs
                  assertBool ("C5 PoK at position " <> show position <> " accepted") (not changedPok)
            | inputCount <- [1 .. 8]
            ]
        , testCase "R1 cached marker chain does not advance the next distinct power" $ do
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let proof1 = distinctFixtureProof firstFixture
                    proof2 = distinctFixtureProof secondFixture
                    credential1 = distinctFixtureCredential firstFixture
                    credential2 = distinctFixtureCredential secondFixture
                    proofSlots =
                      [ proof1
                      , reclaimSameAsPreviousProof
                      , reclaimSameAsPreviousProof
                      , proof2
                      ]
                    expandedTranscript = reclaimProofBytesConcat (proofSlotData proofSlots)
                    challenge = ownershipProofBatchChallenge expandedTranscript
                    distinctCoefficients = [1, challenge]
                    parsed = parseVerifyingKeyBatch destinationVk
                    checks =
                      [ verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed proof1 credential1 destinationAddressBytes
                      , verifyOwnershipDestinationWithParsedBatchVKKnown28NoPok parsed proof2 credential2 destinationAddressBytes
                      ]
                    firstPub = batchCommittedProofPub (head checks)
                    firstECmt = batchCommittedProofECmt (head checks)
                    secondPub = batchCommittedProofPub (checks !! 1)
                    secondECmt = batchCommittedProofECmt (checks !! 1)
                    afterFirstCache =
                      retainBatchScalarState challenge 1 firstPub firstECmt
                    afterSecondCache =
                      case afterFirstCache of
                        (power, s0, sPub, sE) ->
                          retainBatchScalarState power s0 sPub sE
                    afterDistinct =
                      case afterSecondCache of
                        (power, s0, sPub, sE) ->
                          foldBatchScalarState challenge power s0 sPub sE secondPub secondECmt
                    credentials = [credential1, credential1, credential1, credential2]
                    inputs =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "v8-cache")
                          (toInteger index)
                          (ReclaimBaseDatum credential)
                      | (index, credential) <- zip [0 :: Int ..] credentials
                      ]
                expandedTranscript @?= (proof1 <> proof1 <> proof1 <> proof2)
                batchPowers challenge 2 @?= distinctCoefficients
                afterFirstCache @?= (challenge, 1, firstPub, firstECmt)
                afterSecondCache @?= (challenge, 1, firstPub, firstECmt)
                afterDistinct
                  @?= ( (challenge * challenge) `B.modInteger` blsScalarFieldOrder
                      , (1 + challenge) `B.modInteger` blsScalarFieldOrder
                      , (firstPub + challenge * secondPub) `B.modInteger` blsScalarFieldOrder
                      , (firstECmt + challenge * secondECmt) `B.modInteger` blsScalarFieldOrder
                      )
                assertSyntheticCoefficientFold
                  parsed
                  distinctCoefficients
                  (fmap batchCommittedProofPub checks)
                  (fmap batchCommittedProofECmt checks)
                  (fmap batchCommittedProofCommitment checks)
                accepted <- safeBool $
                  runReclaimGlobal destinationVk $
                    reclaimGlobalContextWithOutputs
                      proofSlots
                      0
                      inputs
                      [paramInput]
                      (replicate 4 singleDestinationOutput)
                assertBool "cached chain followed by distinct proof rejected" accepted
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , let malformedCommitment =
                B.consByteString 127 (bytesToBuiltin (replicate 95 255))
              mutations =
                [ ("identity A", replaceProofSlice 0 48 (compressedIdentity 48))
                , ("identity B", replaceProofSlice 48 96 (compressedIdentity 96))
                , ("identity C", replaceProofSlice 144 48 (compressedIdentity 48))
                , ("identity commitment", replaceProofSlice 192 96 uncompressedCommitmentIdentity)
                , ("identity PoK", replaceProofSlice 288 48 (compressedIdentity 48))
                , ("malformed A", replaceProofSlice 0 48 (malformedCompressedPoint 48))
                , ("malformed B", replaceProofSlice 48 96 (malformedCompressedPoint 96))
                , ("malformed C", replaceProofSlice 144 48 (malformedCompressedPoint 48))
                , ("malformed commitment", replaceProofSlice 192 96 malformedCommitment)
                , ("malformed PoK", replaceProofSlice 288 48 (malformedCompressedPoint 48))
                ]
              legacyCase label mutate = testCase label $ do
                ok <- safeBool $
                  runReclaimGlobal
                    destinationVk
                    (reclaimGlobalContext (mutate destinationProof) 0 [reclaimBaseInput] [paramInput])
                assertBool (label <> " unexpectedly accepted by the N=1 legacy parser") (not ok)
              secondDistinctCase label mutate = testCase label $ do
                case take 2 distinctFixtures of
                  [firstFixture, secondFixture] -> do
                    let proof1 = distinctFixtureProof firstFixture
                        proof2 = distinctFixtureProof secondFixture
                        credentials =
                          [ distinctFixtureCredential firstFixture
                          , distinctFixtureCredential secondFixture
                          ]
                        inputs =
                          [ reclaimBaseInputAtWithDatum
                              (B.consByteString (toInteger index) "v8-m1")
                              (toInteger index)
                              (ReclaimBaseDatum credential)
                          | (index, credential) <- zip [0 :: Int ..] credentials
                          ]
                    assertBool "M1 fixtures must enter the distinct-proof transition" (proof1 /= proof2)
                    ok <- safeBool $
                      runReclaimGlobal destinationVk $
                        reclaimGlobalContextWithOutputs
                          [proof1, mutate proof2]
                          0
                          inputs
                          [paramInput]
                          (replicate 2 singleDestinationOutput)
                    assertBool (label <> " unexpectedly accepted as second distinct proof") (not ok)
                  _ -> assertFailure "distinct fixture file has fewer than two rows"
           in testGroup "M1 rejects identity and malformed proof points"
                [ testGroup "N=1 legacy parser"
                    [legacyCase label mutate | (label, mutate) <- mutations]
                , testGroup "N=2 second distinct coefficient-first transition"
                    [secondDistinctCase label mutate | (label, mutate) <- mutations]
                ]
        , testCase "serialized batch path rejects proof lengths 0, 335, and 337" $ do
            forM_
              [ ("zero-length proof", B.emptyByteString)
              , ("335-byte proof", B.sliceByteString 0 335 destinationProof)
              , ("337-byte proof", destinationProof <> B.consByteString 0 B.emptyByteString)
              ] $
              \(label, malformedProof) ->
                assertCompiledReclaimGlobalRejects label destinationVk malformedProof
        , testCase "serialized batch path rejects verifier-key lengths 671 and 673" $ do
            forM_
              [ ("671-byte verifier key", B.sliceByteString 0 671 destinationVk)
              , ("673-byte verifier key", destinationVk <> B.consByteString 0 B.emptyByteString)
              ] $
              \(label, malformedVerifierKey) ->
                assertCompiledReclaimGlobalRejects label malformedVerifierKey destinationProof
        , testCase "serialized batch path rejects commitment Y equal to the base-field modulus" $
            assertCompiledReclaimGlobalRejects
              "commitment Y=p"
              destinationVk
              (proofWithCommitmentY blsBaseFieldOrder destinationProof)
        , testCase "rejects spending-script context even with a valid reclaim proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalSpendingContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects minting-script context even with a valid reclaim proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalMintingContext destinationProof 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects invalid parameter reference index" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 1 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects proof for a different base datum owner" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInputWithDatum (ReclaimBaseDatum wrongPaymentKeyHash)] [paramInput])
            ok @?= False
        , testCase "rejects parameter reference without the parameter NFT" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInputWithValue mempty])
            ok @?= False
        , testCase "rejects a parameter token with the right policy but wrong asset name" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput]
                  [paramInputWithValue (V3.singleton paramCurrencySymbol otherTokenName 1)])
            ok @?= False
        , testCase "rejects a parameter token quantity other than one" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput]
                  [paramInputWithValue (V3.singleton paramCurrencySymbol paramTokenName 2)])
            ok @?= False
        , testCase "rejects multiple token names under the parameter policy" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput]
                  [paramInputWithValue
                    ( V3.singleton paramCurrencySymbol paramTokenName 1
                        <> V3.singleton paramCurrencySymbol otherTokenName 1
                    )])
            ok @?= False
        , testCase "rejects extra non-ADA policies on the parameter output" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput]
                  [paramInputWithValue
                    ( V3.singleton paramCurrencySymbol paramTokenName 1
                        <> V3.singleton otherSymbol otherTokenName 1
                    )])
            ok @?= False
        , testCase "uses the explicitly indexed parameter output when two valid candidates exist" $ do
            let firstParam = paramInputWithValueAt "params-a" 0 (V3.singleton paramCurrencySymbol paramTokenName 1)
                secondParam = paramInputWithValueAt "params-b" 1 (V3.singleton paramCurrencySymbol paramTokenName 1)
            firstSelected <- safeBool $
              runReclaimGlobal destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [firstParam, secondParam])
            secondSelected <- safeBool $
              runReclaimGlobal destinationVk
                (reclaimGlobalContext destinationProof 1 [reclaimBaseInput] [firstParam, secondParam])
            firstSelected @?= True
            secondSelected @?= True
        , testCase "rejects parameter reference without inline params datum" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInputWithoutDatum])
            ok @?= False
        , testCase "rejects unused proofs when no reclaim base inputs exist" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [txIn otherRef] [paramInput])
            ok @?= False
        , testCase "skips non-base inputs while consuming proofs for base inputs" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [txIn otherRef, reclaimBaseInput] [paramInput])
            ok @?= True
        , testCase "rejects missing proof for a reclaim base input" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithProofs [] 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects malformed datum on a matching reclaim base input" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext destinationProof 0 [reclaimBaseInputWithDatum invalidBaseDatum] [paramInput])
            ok @?= False
        , testCase "rejects destination redirection" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [reclaimBaseInput]
                  [paramInput]
                  [pubKeyOutput wrongPaymentKeyHash reclaimValue])
            ok @?= False
        , testCase "accepts two inputs with duplicate owner proofs and corresponding destination outputs" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= True
        , testCase "accepts a full proof followed by a chain of same-as-previous markers" $ do
            let inputs =
                  [ reclaimBaseInput
                  , secondReclaimBaseInput
                  , reclaimBaseInputAt "base-3" 2
                  , reclaimBaseInputAt "base-4" 3
                  ]
                outputs = replicate 4 singleDestinationOutput
            markerDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [ destinationProof
                  , reclaimSameAsPreviousProof
                  , reclaimSameAsPreviousProof
                  , reclaimSameAsPreviousProof
                  ]
                  0
                  inputs
                  [paramInput]
                  outputs)
            expandedDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  (replicate 4 destinationProof)
                  0
                  inputs
                  [paramInput]
                  outputs)
            markerDecision @?= True
            markerDecision @?= expandedDecision
        , testCase "accepts mixed distinct proofs and marker runs" $ do
            let secondDifferentOwnerInput =
                  reclaimBaseInputAtWithDatum
                    "base-different-2"
                    2
                    (ReclaimBaseDatum secondPaymentKeyHash)
                inputs =
                  [ reclaimBaseInput
                  , secondReclaimBaseInput
                  , differentOwnerReclaimBaseInput
                  , secondDifferentOwnerInput
                  ]
                outputs = replicate 4 singleDestinationOutput
                markerProofs =
                  [ firstDistinctProof
                  , reclaimSameAsPreviousProof
                  , secondDistinctProof
                  , reclaimSameAsPreviousProof
                  ]
                expandedProofs =
                  [ firstDistinctProof
                  , firstDistinctProof
                  , secondDistinctProof
                  , secondDistinctProof
                  ]
            markerDecision <- safeBool $
              runReclaimGlobal destinationVk $
                reclaimGlobalContextWithOutputs markerProofs 0 inputs [paramInput] outputs
            expandedDecision <- safeBool $
              runReclaimGlobal destinationVk $
                reclaimGlobalContextWithOutputs expandedProofs 0 inputs [paramInput] outputs
            markerDecision @?= True
            markerDecision @?= expandedDecision
        , testCase "marker transcript expands to the fully repeated proof bytes" $ do
            let markerSlots =
                  [ firstDistinctProof
                  , reclaimSameAsPreviousProof
                  , reclaimSameAsPreviousProof
                  , secondDistinctProof
                  , reclaimSameAsPreviousProof
                  ]
                expandedSlots =
                  [ firstDistinctProof
                  , firstDistinctProof
                  , firstDistinctProof
                  , secondDistinctProof
                  , secondDistinctProof
                  ]
                markerTranscript = reclaimProofBytesConcat (proofSlotData markerSlots)
                expandedTranscript = reclaimProofBytesConcat (proofSlotData expandedSlots)
            markerTranscript @?= expandedTranscript
            ownershipProofBatchChallenge markerTranscript
              @?= ownershipProofBatchChallenge expandedTranscript
        , testCase "rejects a same-as-previous marker in the first proof slot" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContext reclaimSameAsPreviousProof 0 [reclaimBaseInput] [paramInput])
            ok @?= False
        , testCase "rejects marker reuse for a different credential" $ do
            markerDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, reclaimSameAsPreviousProof]
                  0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            expandedDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, destinationProof]
                  0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            markerDecision @?= False
            markerDecision @?= expandedDecision
        , testCase "rejects marker reuse for a different destination" $ do
            markerDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, reclaimSameAsPreviousProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, changedSingleDestinationOutput])
            expandedDecision <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, changedSingleDestinationOutput])
            markerDecision @?= False
            markerDecision @?= expandedDecision
        , testCase "rejects a marker after a failed full proof" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [tamperProof destinationProof, reclaimSameAsPreviousProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= False
        , testCase "rejects a missing second proof instead of inferring reuse" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= False
        , testCase "only the exact empty bytestring is a proof-reuse marker" $ do
            let nonEmptyNearMarker = B.consByteString 0 B.emptyByteString
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof, nonEmptyNearMarker]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= False
        , testCase "rejects a non-bytes proof-slot encoding" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithRawProofs
                  [BI.mkB destinationProof, BI.mkI 0]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, singleDestinationOutput])
            ok @?= False
        , testCase "rejects a destination output that underpays the input value" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [reclaimBaseInput]
                  [paramInput]
                  [underpaidSingleDestinationOutput])
            ok @?= False
        , testCase "single path accepts multi-asset coverage plus an extra paid asset" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [multiAssetReclaimBaseInput]
                  [paramInput]
                  [pubKeyOutput destinationPaymentKeyHash (multiAssetReclaimValue <> V3.singleton ownSymbol tokenName 1)])
            ok @?= True
        , testCase "single path rejects native-asset shortfall by one" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [multiAssetReclaimBaseInput]
                  [paramInput]
                  [pubKeyOutput destinationPaymentKeyHash (reclaimValue <> V3.singleton otherSymbol otherTokenName 4)])
            ok @?= False
        , testCase "single path rejects the right native-asset quantity under a wrong policy" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputs
                  [destinationProof]
                  0
                  [multiAssetReclaimBaseInput]
                  [paramInput]
                  [pubKeyOutput destinationPaymentKeyHash (reclaimValue <> V3.singleton ownSymbol otherTokenName 5)])
            ok @?= False
        , testCase "rejects a destination start index that points at another output" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputsAt
                  [destinationProof]
                  0
                  1
                  [reclaimBaseInput]
                  [paramInput]
                  [singleDestinationOutput, changedSingleDestinationOutput])
            ok @?= False
        , testCase "accepts destination outputs after the provided start index" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithOutputsAt
                  [destinationProof]
                  0
                  1
                  [reclaimBaseInput]
                  [paramInput]
                  [changedSingleDestinationOutput, singleDestinationOutput])
            ok @?= True
        , testCase "rejects a changed duplicate proof for the same owner" $ do
            ok <- safeBool $
              runReclaimGlobal
                destinationVk
                (reclaimGlobalContextWithProofs
                  [destinationProof, tamperProof destinationProof]
                  0
                  [reclaimBaseInput, secondReclaimBaseInput]
                  [paramInput])
            ok @?= False
        ]
    , testGroup "ZK-02 statement-bound ReclaimGlobal V2"
        [ testCase "golden ordinary transcript frames key hash, count, proof, and digest exactly" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                publicInputDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                transcript =
                  StatementV2.reclaimBatchTranscriptV2
                    verifierKeyHash
                    (proofSlotData [destinationProof])
                    (proofSlotData [publicInputDigest])
                expected =
                  ownershipProofBatchDomainV2
                    <> verifierKeyHash
                    <> B.integerToByteString BigEndian 2 1
                    <> destinationProof
                    <> publicInputDigest
            transcript @?= expected
            B.blake2b_256 transcript
              @?= bytesToBuiltin (decodeHex "de2ec581b4867c873d19ee352057b16779eeb7ed436389df3ddae83e4bc0ab83")
            ownershipProofBatchChallengeV2 transcript
              @?= 48060215316213728234324688594236774953373129272802377419741970201232745212804
            ownershipProofBatchMergeChallengeV2 transcript
              @?= 29977684646305213087720291628589158366516279582163771712988317671212115003480
        , testCase "golden all-distinct, repeated-full, and multi slots stay source-backed" $ do
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let verifierKeyHash = B.blake2b_256 destinationVk
                    distinctProofs = [distinctFixtureProof firstFixture, distinctFixtureProof secondFixture]
                    distinctDigests =
                      [ ownershipDestinationPublicInputDigest (distinctFixtureCredential firstFixture) destinationAddressBytes
                      , ownershipDestinationPublicInputDigest (distinctFixtureCredential secondFixture) destinationAddressBytes
                      ]
                    distinctTranscript = StatementV2.reclaimBatchTranscriptV2 verifierKeyHash (proofSlotData distinctProofs) (proofSlotData distinctDigests)
                    repeatedDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                    repeatedTranscript = StatementV2.reclaimBatchTranscriptV2 verifierKeyHash (proofSlotData [destinationProof, destinationProof]) (proofSlotData [repeatedDigest, repeatedDigest])
                    multiTranscript = StatementV2.reclaimBatchTranscriptV2 (B.blake2b_256 multiVk) (proofSlotData [multiProof]) (proofSlotData [multiPub])
                B.blake2b_256 distinctTranscript
                  @?= bytesToBuiltin (decodeHex "0c849a5a3f2b4327b0e0eea6520aa84c1662f37981f82d85c6d6f27969e87448")
                ownershipProofBatchChallengeV2 distinctTranscript
                  @?= 5662043297535020645469022094265343656989199811666117524552659575412787541065
                ownershipProofBatchMergeChallengeV2 distinctTranscript
                  @?= 3408456196945533147107153784347933353366880282834100023276788048486737464439
                B.blake2b_256 repeatedTranscript
                  @?= bytesToBuiltin (decodeHex "96ec2575743ca545aea201301e87d598f4bc92f480ea13e41e8cee7cab589a80")
                ownershipProofBatchChallengeV2 repeatedTranscript
                  @?= 15828286550821231769909291562785054634164136086768740444028986104469549259393
                ownershipProofBatchMergeChallengeV2 repeatedTranscript
                  @?= 9391575678614049270571466634721242011149899531674896019326654660340751583079
                B.blake2b_256 multiTranscript
                  @?= bytesToBuiltin (decodeHex "59b22d408d6c4965eb78632c959557811f00d99969b28ccddfba0012753cff71")
                ownershipProofBatchChallengeV2 multiTranscript
                  @?= 40570654620357032943455514758320935667228665531329494875443015168245154774898
                ownershipProofBatchMergeChallengeV2 multiTranscript
                  @?= 8636757789949591304714306246332989594687787538241662237540073471059061109757
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "accepts ordinary, all-distinct, and repeated full proof slots" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                ordinaryDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
            ordinary <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash $
                reclaimGlobalStatementV2ContextWithOutputs [destinationProof] [ordinaryDigest] 0 [reclaimBaseInput] [paramInput] [singleDestinationOutput]
            ordinary @?= True
            repeated <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash $
                reclaimGlobalStatementV2ContextWithOutputs [destinationProof, destinationProof] [ordinaryDigest, ordinaryDigest] 0 [reclaimBaseInput, secondReclaimBaseInput] [paramInput] [singleDestinationOutput, singleDestinationOutput]
            repeated @?= True
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let fixtures = [firstFixture, secondFixture]
                    proofs = fmap distinctFixtureProof fixtures
                    digests = [ownershipDestinationPublicInputDigest (distinctFixtureCredential fixture) destinationAddressBytes | fixture <- fixtures]
                    inputs =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "zk-02-distinct")
                          (toInteger index)
                          (ReclaimBaseDatum (distinctFixtureCredential fixture))
                      | (index, fixture) <- zip [0 :: Int ..] fixtures
                      ]
                distinct <- safeBool $
                  runReclaimGlobalStatementV2 destinationVk verifierKeyHash $
                    reclaimGlobalStatementV2ContextWithOutputs proofs digests 0 inputs [paramInput] [singleDestinationOutput, singleDestinationOutput]
                distinct @?= True
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "rejects V1 redeemers, markers, and unauthenticated digest substitutions" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                actualDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                wrongDigest = flipFirstBit actualDigest
                context proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs proofs digests 0 [reclaimBaseInput] [paramInput] [singleDestinationOutput]
            v1 <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (reclaimGlobalContext destinationProof 0 [reclaimBaseInput] [paramInput])
            marker <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [reclaimSameAsPreviousProof] [actualDigest])
            shortProof <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [B.sliceByteString 0 335 destinationProof] [actualDigest])
            longProof <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof <> B.consByteString 0 B.emptyByteString] [actualDigest])
            shortDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [B.sliceByteString 0 31 actualDigest])
            longDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [actualDigest <> B.consByteString 0 B.emptyByteString])
            substitutedDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [wrongDigest])
            missingDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [])
            extraDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [actualDigest, actualDigest])
            v1 @?= False
            marker @?= False
            shortProof @?= False
            longProof @?= False
            shortDigest @?= False
            longDigest @?= False
            substitutedDigest @?= False
            missingDigest @?= False
            extraDigest @?= False
        , testCase "applied V2 rejects malformed parameters and empty or misaligned slots" $ do
            let digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                verifierKeyHash = B.blake2b_256 destinationVk
                one proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs
                    proofs
                    digests
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                two proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs
                    proofs
                    digests
                    0
                    [reclaimBaseInput, secondReclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput, singleDestinationOutput]
            forM_
              [ ("671-byte verifier key", B.sliceByteString 0 671 destinationVk, B.blake2b_256 (B.sliceByteString 0 671 destinationVk))
              , ("673-byte verifier key", destinationVk <> B.consByteString 0 B.emptyByteString, B.blake2b_256 (destinationVk <> B.consByteString 0 B.emptyByteString))
              , ("31-byte verifier-key hash", destinationVk, B.sliceByteString 0 31 verifierKeyHash)
              , ("33-byte verifier-key hash", destinationVk, verifierKeyHash <> B.consByteString 0 B.emptyByteString)
              ]
              $ \(label, malformedVk, malformedHash) -> do
                accepted <- safeBool $ runReclaimGlobalStatementV2 malformedVk malformedHash (one [destinationProof] [digest])
                assertBool (label <> " unexpectedly succeeded") (not accepted)
            forM_
              [ ("missing proof", one [] [digest])
              , ("missing digest", one [destinationProof] [])
              , ("extra proof", one [destinationProof, destinationProof] [digest])
              , ("extra digest", one [destinationProof] [digest, digest])
              , ("extra full proof/digest pair for one claim", one [destinationProof, destinationProof] [digest, digest])
              , ("one full proof/digest pair for two claims", two [destinationProof] [digest])
              ]
              $ \(label, ctx) -> do
                accepted <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash ctx
                assertBool (label <> " unexpectedly succeeded") (not accepted)
            zeroSlot <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash $
                reclaimGlobalStatementV2ContextWithOutputs [] [] 0 [] [paramInput] []
            zeroSlot @?= False
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let fixtures = [firstFixture, secondFixture]
                    proofs = fmap distinctFixtureProof fixtures
                    digests = fmap (\fixture -> ownershipDestinationPublicInputDigest (distinctFixtureCredential fixture) destinationAddressBytes) fixtures
                    inputs =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "zk-02-applied-digest-order")
                          (toInteger index)
                          (ReclaimBaseDatum (distinctFixtureCredential fixture))
                      | (index, fixture) <- zip [0 :: Int ..] fixtures
                      ]
                    reorderedCtx =
                      reclaimGlobalStatementV2ContextWithOutputs
                        proofs
                        (reverse digests)
                        0
                        inputs
                        [paramInput]
                        [singleDestinationOutput, singleDestinationOutput]
                reordered <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash reorderedCtx
                reordered @?= False
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "compiled V2 script accepts an authenticated slot and rejects a substituted digest" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                actualDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                validContext =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [actualDigest]
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                invalidContext =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [flipFirstBit actualDigest]
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                script = compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash
                (valid, validLogsEmpty) = evaluateCompiledScript script validContext
                (invalid, invalidLogsEmpty) = evaluateCompiledScript script invalidContext
            valid @?= True
            invalid @?= False
            validLogsEmpty @?= True
            invalidLogsEmpty @?= True
        , testCase "V2 export parameter guard rejects a same-width verifier-key hash mismatch" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
            StatementV2.v2VerifierKeyParametersMatch destinationVk verifierKeyHash @?= True
            StatementV2.v2VerifierKeyParametersMatch destinationVk (flipFirstBit verifierKeyHash) @?= False
        , testCase "reclaim-scripts-export global-v2 rejects a same-width verifier-key hash mismatch" $ do
            verifierKeyHex <- filter isHexDigit <$> readFile "testdata/ownership-destination-vk.hex"
            let canonicalHash = "1ad50c111d8d78897e4e5b08d361e6e0ca57a7b8e782ae030e0c645ed5ff7758"
                wrongHash = '0' : tail canonicalHash
                canonicalHashBytes = bytesToBuiltin (decodeHex canonicalHash)
                wrongHashBytes = bytesToBuiltin (decodeHex wrongHash)
            length verifierKeyHex @?= 1344
            length wrongHash @?= 64
            StatementV2.v2VerifierKeyParametersMatch destinationVk canonicalHashBytes @?= True
            StatementV2.v2VerifierKeyParametersMatch destinationVk wrongHashBytes @?= False
            (status, stdout, stderr) <-
              readProcessWithExitCode
                "reclaim-scripts-export"
                [ "global-v2"
                , replicate 56 '0'
                , ""
                , verifierKeyHex
                , wrongHash
                ]
                ""
            status @?= ExitFailure 1
            stdout @?= ""
            stderr @?= "verifier key hash does not match canonical verifier key bytes\n"
        , testCase "compiled V2 script rejects malformed verifier-key and hash widths" $ do
            let digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                ctx =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [digest]
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                verifierKeyHash = B.blake2b_256 destinationVk
            forM_
              [ ("671-byte verifier key", B.sliceByteString 0 671 destinationVk, B.blake2b_256 (B.sliceByteString 0 671 destinationVk))
              , ("673-byte verifier key", destinationVk <> B.consByteString 0 B.emptyByteString, B.blake2b_256 (destinationVk <> B.consByteString 0 B.emptyByteString))
              , ("31-byte verifier-key hash", destinationVk, B.sliceByteString 0 31 verifierKeyHash)
              , ("33-byte verifier-key hash", destinationVk, verifierKeyHash <> B.consByteString 0 B.emptyByteString)
              ]
              $ \(label, malformedVk, malformedHash) ->
                assertCompiledReclaimGlobalStatementV2Rejects label malformedVk malformedHash ctx
        , testCase "compiled V2 script rejects digest-only all-distinct reordering" $
            case take 2 distinctFixtures of
              [firstFixture, secondFixture] -> do
                let fixtures = [firstFixture, secondFixture]
                    proofs = fmap distinctFixtureProof fixtures
                    digests = fmap (\fixture -> ownershipDestinationPublicInputDigest (distinctFixtureCredential fixture) destinationAddressBytes) fixtures
                    inputs =
                      [ reclaimBaseInputAtWithDatum
                          (B.consByteString (toInteger index) "zk-02-compiled-digest-order")
                          (toInteger index)
                          (ReclaimBaseDatum (distinctFixtureCredential fixture))
                      | (index, fixture) <- zip [0 :: Int ..] fixtures
                      ]
                    validCtx =
                      reclaimGlobalStatementV2ContextWithOutputs
                        proofs
                        digests
                        0
                        inputs
                        [paramInput]
                        [singleDestinationOutput, singleDestinationOutput]
                    reorderedCtx =
                      reclaimGlobalStatementV2ContextWithOutputs
                        proofs
                        (reverse digests)
                        0
                        inputs
                        [paramInput]
                        [singleDestinationOutput, singleDestinationOutput]
                    script = compiledReclaimGlobalStatementV2Script destinationVk (B.blake2b_256 destinationVk)
                    (valid, validLogsEmpty) = evaluateCompiledScript script validCtx
                    (reordered, reorderedLogsEmpty) = evaluateCompiledScript script reorderedCtx
                valid @?= True
                validLogsEmpty @?= True
                reordered @?= False
                reorderedLogsEmpty @?= True
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "compiled V2 script rejects proof/digest asymmetry and claim-count mismatch" $ do
            let digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                one proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs
                    proofs
                    digests
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                two proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs
                    proofs
                    digests
                    0
                    [reclaimBaseInput, secondReclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput, singleDestinationOutput]
                verifierKeyHash = B.blake2b_256 destinationVk
            forM_
              [ ("missing proof", one [] [digest])
              , ("missing digest", one [destinationProof] [])
              , ("extra proof", one [destinationProof, destinationProof] [digest])
              , ("extra digest", one [destinationProof] [digest, digest])
              , ("extra full proof/digest pair for one claim", one [destinationProof, destinationProof] [digest, digest])
              , ("one full proof/digest pair for two claims", two [destinationProof] [digest])
              ]
              $ \(label, ctx) ->
                assertCompiledReclaimGlobalStatementV2Rejects label destinationVk verifierKeyHash ctx
        , testCase "compiled V2 script rejects a zero-slot batch" $
            assertCompiledReclaimGlobalStatementV2Rejects
              "zero-slot V2 batch"
              destinationVk
              (B.blake2b_256 destinationVk)
              (reclaimGlobalStatementV2ContextWithOutputs [] [] 0 [] [paramInput] [])
        ]
    , testGroup "Ownership.ReclaimGlobalMulti"
        [ testCase "encodes the fixed-byte multi public input digest" $
            multiCredentialPublicInputDigest 2 twoCredentialBytes destinationAddressBytes
              @?= B.blake2b_256
                ( multiOwnershipDomain
                    <> multiCredentialCountU16BE 2
                    <> twoCredentialBytes
                    <> destinationAddressBytes
                )
        , testCase "encodes destination addresses as payment tag/hash plus no-stake tag/zero hash" $
            destinationAddressV1FromTxOutData (V3.toBuiltinData exactDestinationOutput)
              @?= destinationAddressBytes
        , testCase "exported multi pub fixture equals the contract digest" $
            multiPub @?= multiCredentialPublicInputDigest 2 twoCredentialBytes destinationAddressBytes
        , testCase "core logic accepts two reclaim-base inputs when one multi proof matches the batch digest" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 twoCredentialBytes destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "rejects when the proof omits a matching credential" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 1 goldenPaymentKeyHash destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the proof changes a matching credential" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (goldenPaymentKeyHash <> thirdPaymentKeyHash) destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the proof reorders credentials" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (secondPaymentKeyHash <> goldenPaymentKeyHash) destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when the destination output address changes" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 twoCredentialBytes destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [changedDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects aggregate underpayment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData [underpaidDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "accepts aggregate exact payment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "accepts aggregate overpayment" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData [overpaidDestinationOutput])
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "accepts aggregate split across contiguous destination outputs" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData splitDestinationOutputs)
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= True
        , testCase "stops aggregate scan at the first different destination address" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData splitDestinationOutputsWithGap)
                (txInListData [reclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects native-asset underpayment even when lovelace is covered" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData [missingNativeAssetDestinationOutput])
                (txInListData [multiAssetReclaimBaseInput, differentOwnerReclaimBaseInput])
            ok @?= False
        , testCase "rejects when no reclaim-base inputs are present" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                proofMatchesActual
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [txIn otherRef])
            ok @?= False
        , testCase "multi validator rejects the right parameter policy with the wrong asset name" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [paramInputWithValue (V3.singleton paramCurrencySymbol otherTokenName 1)]
                  [exactDestinationOutput])
            ok @?= False
        , testCase "multi validator rejects a parameter token quantity other than one" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [paramInputWithValue (V3.singleton paramCurrencySymbol paramTokenName 2)]
                  [exactDestinationOutput])
            ok @?= False
        , testCase "multi validator uses the explicitly indexed parameter output when two valid candidates exist" $ do
            let firstParam = paramInputWithValueAt "params-multi-a" 0 (V3.singleton paramCurrencySymbol paramTokenName 1)
                secondParam = paramInputWithValueAt "params-multi-b" 1 (V3.singleton paramCurrencySymbol paramTokenName 1)
            firstSelected <- safeBool $
              runReclaimGlobalMulti multiVk
                (reclaimGlobalMultiContext multiProof 0 0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [firstParam, secondParam]
                  [exactDestinationOutput])
            secondSelected <- safeBool $
              runReclaimGlobalMulti multiVk
                (reclaimGlobalMultiContext multiProof 1 0
                  [reclaimBaseInput, differentOwnerReclaimBaseInput]
                  [firstParam, secondParam]
                  [exactDestinationOutput])
            firstSelected @?= True
            secondSelected @?= True
        , testCase "rejects an out-of-bounds destination output index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "rejects a negative destination output index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 (-1) [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "allows duplicate credentials when every matching input is represented in order" $ do
            ok <- safeBool $
              validateMultiReclaimInputsWithProofCheck
                (proofMatches 2 (goldenPaymentKeyHash <> goldenPaymentKeyHash) destinationAddressBytes)
                baseScriptHashBytes
                (txOutListData [exactDestinationOutput])
                (txInListData [reclaimBaseInput, secondReclaimBaseInput])
            ok @?= True
        , testCase "does not accept the single-credential proof as a multi-credential proof" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                vk
                (reclaimGlobalMultiContext proof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "accepts two reclaim-base inputs with the exported real multi proof" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= True
        , testCase "real multi proof accepts contiguous same-address destination outputs" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] splitDestinationOutputs)
            ok @?= True
        , testCase "real multi proof accepts destination run after the provided start index" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] (changedDestinationOutput : splitDestinationOutputs))
            ok @?= True
        , testCase "real multi proof rejects swapped txInfoInputs order" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [differentOwnerReclaimBaseInput, reclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects a changed credential datum" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, thirdOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects a changed destination address" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [changedDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects when destination index points at another output" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 1 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [exactDestinationOutput, changedDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects aggregate underpayment" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [underpaidDestinationOutput])
            ok @?= False
        , testCase "real multi proof ignores later same-address output after a gap" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [reclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] splitDestinationOutputsWithGap)
            ok @?= False
        , testCase "real multi proof rejects native-asset underpayment" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [multiAssetReclaimBaseInput, differentOwnerReclaimBaseInput] [paramInput] [missingNativeAssetDestinationOutput])
            ok @?= False
        , testCase "real multi proof rejects no matching reclaim-base inputs" $ do
            ok <- safeBool $
              runReclaimGlobalMulti
                multiVk
                (reclaimGlobalMultiContext multiProof 0 0 [txIn otherRef] [paramInput] [exactDestinationOutput])
            ok @?= False
        ]
    ]

goldenPaymentKeyHash :: BuiltinByteString
goldenPaymentKeyHash =
  bytesToBuiltin (decodeHex "19e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

wrongPaymentKeyHash :: BuiltinByteString
wrongPaymentKeyHash =
  bytesToBuiltin (decodeHex "18e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

secondPaymentKeyHash :: BuiltinByteString
secondPaymentKeyHash =
  bytesToBuiltin (decodeHex "155a68f5db6e170a0f0c7d211c24dce882b23e18244f1f142a5fa377")

thirdPaymentKeyHash :: BuiltinByteString
thirdPaymentKeyHash =
  bytesToBuiltin (decodeHex "17e07fbcc7577359d6c51f1e49cf1b0bf4c943b48ba4e4905a8702e4")

destinationPaymentKeyHash :: BuiltinByteString
destinationPaymentKeyHash =
  bytesToBuiltin (decodeHex "0038ff22c6562b1277ef0d3eb3b8b4892523eeba04d0ef0c9d7da111")

seedRef :: V3.TxOutRef
seedRef =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId "seed"
    , V3.txOutRefIdx = 0
    }

otherRef :: V3.TxOutRef
otherRef =
  V3.TxOutRef
    { V3.txOutRefId = V3.TxId "other"
    , V3.txOutRefIdx = 1
    }

ownSymbol :: V3.CurrencySymbol
ownSymbol = V3.CurrencySymbol "own-policy"

otherSymbol :: V3.CurrencySymbol
otherSymbol = V3.CurrencySymbol "other-policy"

tokenName :: V3.TokenName
tokenName = V3.TokenName "params"

otherTokenName :: V3.TokenName
otherTokenName = V3.TokenName "other"

globalCredential :: V3.Credential
globalCredential = V3.ScriptCredential globalScriptHash

globalScriptHash :: V3.ScriptHash
globalScriptHash = V3.ScriptHash "global-reclaim"

keyGlobalCredential :: V3.Credential
keyGlobalCredential = V3.PubKeyCredential (V3.PubKeyHash "key-global")

otherGlobalCredential :: V3.Credential
otherGlobalCredential = V3.ScriptCredential (V3.ScriptHash "other-global")

data ReclaimDatumMode
  = DatumInlineValid
  | DatumInlineWrongLength Int
  | DatumInlineWrongConstructor
  | DatumInlineNoFields
  | DatumInlineExtraField
  | DatumInlineNonBytesField
  | DatumMissing
  | DatumByHash
  deriving (Eq, Show)

data BasePurpose
  = PurposeSpending
  | PurposeMinting
  | PurposeRewarding
  | PurposeCertifying
  | PurposeVoting
  | PurposeProposing
  deriving (Eq, Show)

data WithdrawalKeyShape
  = WithdrawalExpected
  | WithdrawalOtherScript
  | WithdrawalOtherKey
  deriving (Eq, Show)

data ReclaimBaseDifferentialCase = ReclaimBaseDifferentialCase
  { differentialGlobalCredential :: V3.Credential
  , differentialDatumMode :: ReclaimDatumMode
  , differentialPurpose :: BasePurpose
  , differentialWithdrawals :: [(WithdrawalKeyShape, Integer)]
  }
  deriving (Show)

reclaimBaseCertificate :: V3.TxCert
reclaimBaseCertificate = V3.TxCertRegStaking globalCredential Nothing

reclaimBaseVoter :: V3.Voter
reclaimBaseVoter = V3.StakePoolVoter (V3.PubKeyHash "property-voter")

reclaimBaseGovernanceActionId :: V3.GovernanceActionId
reclaimBaseGovernanceActionId = V3.GovernanceActionId (V3.TxId "property-governance-action") 0

reclaimBaseProposal :: V3.ProposalProcedure
reclaimBaseProposal = V3.ProposalProcedure 0 otherGlobalCredential V3.InfoAction

builtinDataList :: [BuiltinData] -> BI.BuiltinList BuiltinData
builtinDataList = foldr BI.mkCons (BI.mkNilData BI.unitval)

reclaimBaseDatumData :: ReclaimDatumMode -> BuiltinData
reclaimBaseDatumData DatumInlineValid = V3.toBuiltinData validBaseDatum
reclaimBaseDatumData (DatumInlineWrongLength datumLength) =
  V3.toBuiltinData (ReclaimBaseDatum (bytesToBuiltin (replicate datumLength 0)))
reclaimBaseDatumData DatumInlineWrongConstructor =
  BI.mkConstr 1 (builtinDataList [BI.mkB goldenPaymentKeyHash])
reclaimBaseDatumData DatumInlineNoFields = BI.mkConstr 0 (builtinDataList [])
reclaimBaseDatumData DatumInlineExtraField =
  BI.mkConstr 0 (builtinDataList [BI.mkB goldenPaymentKeyHash, BI.mkI 0])
reclaimBaseDatumData DatumInlineNonBytesField =
  BI.mkConstr 0 (builtinDataList [BI.mkI 0])
reclaimBaseDatumData DatumMissing = V3.toBuiltinData ()
reclaimBaseDatumData DatumByHash = V3.toBuiltinData ()

reclaimBaseContextForDatum :: ReclaimDatumMode -> [(V3.Credential, V3.Lovelace)] -> V3.ScriptContext
reclaimBaseContextForDatum datumMode withdrawals =
  buildScriptContext $
    foldMap (uncurry withWithdrawal) withdrawals
      <> withSpendingScript
        (V3.toBuiltinData ())
        ( withOutRef seedRef
            <> withAddress (scriptAddress baseScriptHash)
            <> datumBuilder datumMode
        )
  where
    datumBuilder mode@DatumInlineValid = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder mode@(DatumInlineWrongLength _) = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder mode@DatumInlineWrongConstructor = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder mode@DatumInlineNoFields = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder mode@DatumInlineExtraField = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder mode@DatumInlineNonBytesField = withInlineDatum (reclaimBaseDatumData mode)
    datumBuilder DatumMissing = mempty
    datumBuilder DatumByHash = withDatumHash (V3.DatumHash "datum-by-hash")

withBasePurpose :: BasePurpose -> V3.ScriptContext -> V3.ScriptContext
withBasePurpose PurposeSpending ctx = ctx
withBasePurpose PurposeMinting ctx =
  ctx {V3.scriptContextScriptInfo = V3.MintingScript (V3.CurrencySymbol "property-policy")}
withBasePurpose PurposeRewarding ctx =
  ctx {V3.scriptContextScriptInfo = V3.RewardingScript otherGlobalCredential}
withBasePurpose PurposeCertifying ctx =
  ctx
    { V3.scriptContextTxInfo =
        (V3.scriptContextTxInfo ctx) {V3.txInfoTxCerts = [reclaimBaseCertificate]}
    , V3.scriptContextScriptInfo = V3.CertifyingScript 0 reclaimBaseCertificate
    }
withBasePurpose PurposeVoting ctx =
  ctx
    { V3.scriptContextTxInfo =
        (V3.scriptContextTxInfo ctx)
          { V3.txInfoVotes =
              Map.safeFromList
                [ ( reclaimBaseVoter
                  , Map.safeFromList [(reclaimBaseGovernanceActionId, V3.VoteYes)]
                  )
                ]
          }
    , V3.scriptContextScriptInfo = V3.VotingScript reclaimBaseVoter
    }
withBasePurpose PurposeProposing ctx =
  ctx
    { V3.scriptContextTxInfo =
        (V3.scriptContextTxInfo ctx) {V3.txInfoProposalProcedures = [reclaimBaseProposal]}
    , V3.scriptContextScriptInfo = V3.ProposingScript 0 reclaimBaseProposal
    }

genReclaimBaseDifferentialCase :: QC.Gen ReclaimBaseDifferentialCase
genReclaimBaseDifferentialCase = do
  credential <- QC.elements [globalCredential, otherGlobalCredential, keyGlobalCredential]
  datumMode <-
    QC.frequency
      [ (4, pure DatumInlineValid)
      , (1, DatumInlineWrongLength <$> QC.elements [0, 5, 27, 29, 64])
      , (1, pure DatumInlineWrongConstructor)
      , (1, pure DatumInlineNoFields)
      , (1, pure DatumInlineExtraField)
      , (1, pure DatumInlineNonBytesField)
      , (1, pure DatumMissing)
      , (1, pure DatumByHash)
      ]
  purpose <-
    QC.elements
      [ PurposeSpending
      , PurposeMinting
      , PurposeRewarding
      , PurposeCertifying
      , PurposeVoting
      , PurposeProposing
      ]
  chosenShapes <-
    QC.sublistOf [WithdrawalExpected, WithdrawalOtherScript, WithdrawalOtherKey]
      >>= QC.shuffle
  withdrawals <-
    traverse
      (\shape -> (,) shape <$> QC.chooseInteger (0, 2000000))
      chosenShapes
  pure $
    ReclaimBaseDifferentialCase
      { differentialGlobalCredential = credential
      , differentialDatumMode = datumMode
      , differentialPurpose = purpose
      , differentialWithdrawals = withdrawals
      }

shrinkReclaimBaseDifferentialCase :: ReclaimBaseDifferentialCase -> [ReclaimBaseDifferentialCase]
shrinkReclaimBaseDifferentialCase differentialCase =
  [ differentialCase {differentialGlobalCredential = credential}
  | credential <- shrinkCredential (differentialGlobalCredential differentialCase)
  ]
    <> [ differentialCase {differentialDatumMode = datumMode}
       | datumMode <- shrinkDatumMode (differentialDatumMode differentialCase)
       ]
    <> [ differentialCase {differentialPurpose = purpose}
       | purpose <- shrinkPurpose (differentialPurpose differentialCase)
       ]
    <> [ differentialCase {differentialWithdrawals = withdrawals}
       | withdrawals <- QC.shrinkList shrinkWithdrawal (differentialWithdrawals differentialCase)
       ]
  where
    shrinkCredential credential
      | credential == globalCredential = []
      | otherwise = [globalCredential]

    shrinkDatumMode DatumInlineValid = []
    shrinkDatumMode (DatumInlineWrongLength 0) = [DatumMissing]
    shrinkDatumMode (DatumInlineWrongLength _) = [DatumInlineWrongLength 0, DatumMissing]
    shrinkDatumMode DatumMissing = []
    shrinkDatumMode _ = [DatumMissing]

    shrinkPurpose PurposeSpending = []
    shrinkPurpose _ = [PurposeSpending]

    shrinkWithdrawal (shape, amount) =
      [(shape, smallerAmount) | smallerAmount <- QC.shrinkIntegral amount]

deduplicateWithdrawals :: [(V3.Credential, V3.Lovelace)] -> [(V3.Credential, V3.Lovelace)]
deduplicateWithdrawals = nubBy (\(left, _) (right, _) -> left == right)

reclaimBaseDifferentialProperty :: ReclaimBaseDifferentialCase -> QC.Property
reclaimBaseDifferentialProperty differentialCase =
  QC.checkCoverage $
    QC.cover 20 (differentialDatumMode differentialCase == DatumInlineValid) "valid inline datum" $
      QC.cover 5 (isBoundaryWrongLength (differentialDatumMode differentialCase)) "boundary wrong datum length" $
        QC.cover 20 (isMalformedInlineDatum (differentialDatumMode differentialCase)) "malformed inline datum" $
          QC.cover 5 (differentialDatumMode differentialCase == DatumInlineExtraField) "trailing datum fields" $
            QC.cover 5 (differentialDatumMode differentialCase == DatumMissing) "missing datum" $
              QC.cover 5 (differentialDatumMode differentialCase == DatumByHash) "datum-by-hash" $
                QC.cover 10 (differentialPurpose differentialCase == PurposeSpending) "SpendingScript" $
                  QC.cover 10 (differentialPurpose differentialCase == PurposeMinting) "MintingScript" $
                    QC.cover 10 (differentialPurpose differentialCase == PurposeRewarding) "RewardingScript" $
                      QC.cover 10 (differentialPurpose differentialCase == PurposeCertifying) "CertifyingScript" $
                        QC.cover 10 (differentialPurpose differentialCase == PurposeVoting) "VotingScript" $
                          QC.cover 10 (differentialPurpose differentialCase == PurposeProposing) "ProposingScript" $
                            QC.cover 30 (length withdrawals > 1) "multiple distinct withdrawals" $
                              QC.cover 8 (null withdrawals) "empty withdrawal map" $
                                QC.cover 35 expectedWithdrawalPresent "expected withdrawal present" $
                                  QC.cover 20 wrongWithdrawalsOnly "wrong withdrawals only" $
                                    QC.cover 40 hasKeyShapedWithdrawal "key-shaped withdrawal" $
                                      QC.cover 20 (credential == keyGlobalCredential) "key-shaped global" $
                                        QC.cover 0.5 oracleDecision "oracle acceptance" $
                                          QC.counterexample (show differentialCase) $
                                            QC.ioProperty $ do
                                              rawDecision <- safeBool (runRawReclaimBase credential ctx)
                                              pure (oracleDecision QC.=== rawDecision)
  where
    credential = differentialGlobalCredential differentialCase
    withdrawalSpecs = differentialWithdrawals differentialCase
    withdrawals =
      deduplicateWithdrawals $
        fmap (\(shape, amount) -> (credentialFor shape, fromInteger amount)) withdrawalSpecs
    credentialFor WithdrawalExpected = credential
    credentialFor WithdrawalOtherScript =
      if credential == otherGlobalCredential then globalCredential else otherGlobalCredential
    credentialFor WithdrawalOtherKey = keyGlobalCredential
    ctx =
      withBasePurpose
        (differentialPurpose differentialCase)
        (reclaimBaseContextForDatum (differentialDatumMode differentialCase) withdrawals)
    expectedWithdrawalPresent = any ((== credential) . fst) withdrawals
    wrongWithdrawalsOnly = not expectedWithdrawalPresent && not (null withdrawals)
    hasKeyShapedWithdrawal = any ((== keyGlobalCredential) . fst) withdrawals
    oracleDecision = reclaimBaseValidatorOracle credential ctx

    isBoundaryWrongLength (DatumInlineWrongLength datumLength) = datumLength `elem` [0, 27, 29]
    isBoundaryWrongLength _ = False

    isMalformedInlineDatum DatumInlineWrongConstructor = True
    isMalformedInlineDatum DatumInlineNoFields = True
    isMalformedInlineDatum DatumInlineExtraField = True
    isMalformedInlineDatum DatumInlineNonBytesField = True
    isMalformedInlineDatum _ = False

-- These test fixtures deliberately model only ledger-normalized UTxO values:
-- policy and token lists are in lexicographic order, unique, and every
-- represented amount is positive. `unsafeFromList` is safe under those local
-- construction rules and gives the on-chain comparator the exact raw Value
-- field it receives from a ledger-built TxOut.
type LedgerValue = [(V3.CurrencySymbol, [(V3.TokenName, Integer)])]

data LedgerValueCoverageCase = LedgerValueCoverageCase
  { coverageRequired :: LedgerValue
  , coveragePaid :: LedgerValue
  }
  deriving (Show)

genLedgerValueCoverageCase :: QC.Gen LedgerValueCoverageCase
genLedgerValueCoverageCase =
  LedgerValueCoverageCase <$> genLedgerValue <*> genLedgerValue

genLedgerValue :: QC.Gen LedgerValue
genLedgerValue = do
  adaQuantity <- QC.chooseInteger (10000000, 20000000)
  nativePolicies <- concat <$> mapM genOptionalPolicy nativeValueCoveragePolicyUniverse
  pure ((V3.adaSymbol, [(V3.adaToken, adaQuantity)]) : nativePolicies)
  where
    genOptionalPolicy (policyId, tokenNames) = do
      selectedTokens <- QC.sublistOf tokenNames
      tokens <-
        mapM
          (\tokenName' -> do
              quantity <- QC.chooseInteger (1, 10)
              pure (tokenName', quantity)
          )
          selectedTokens
      pure $ case tokens of
        [] -> []
        _ -> [(policyId, tokens)]

-- This excludes ADA because every generated output carries its positive ADA
-- entry first. The outer and inner lists are sorted in ledger order.
nativeValueCoveragePolicyUniverse :: [(V3.CurrencySymbol, [V3.TokenName])]
nativeValueCoveragePolicyUniverse =
  [ (policyA, [V3.TokenName "", tokenA, V3.TokenName "z"])
  , (policyB, [V3.TokenName "", tokenA, V3.TokenName "y"])
  , (policyC, [V3.TokenName "", V3.TokenName "c"])
  ]

valueCoverageDifferentialProperty :: LedgerValueCoverageCase -> QC.Property
valueCoverageDifferentialProperty coverageCase =
  QC.checkCoverage $
    QC.cover 15 (hasEmptyNativeToken required || hasEmptyNativeToken paid) "empty native token" $
      QC.cover 15 (hasNativeAsset required || hasNativeAsset paid) "native asset" $
        QC.cover 15 (hasMultiplePolicies required || hasMultiplePolicies paid) "multiple policies" $
          QC.counterexample (show coverageCase) $
            QC.conjoin
              [ oracleDecision QC.=== v1Decision
              , oracleDecision QC.=== v2Decision
              ]
  where
    required = coverageRequired coverageCase
    paid = coveragePaid coverageCase
    requiredValue = ledgerValue required
    paidValue = ledgerValue paid
    oracleDecision = requiredValue `Value.leq` paidValue
    v1Decision = ledgerValueCoverage requiredValue paidValue
    v2Decision = ledgerValueCoverageV2 requiredValue paidValue

    hasEmptyNativeToken =
      any
        (\(currencySymbol, tokens) ->
            currencySymbol /= V3.adaSymbol
              && any ((== V3.adaToken) . fst) tokens
        )
    hasNativeAsset = any ((/= V3.adaSymbol) . fst)
    hasMultiplePolicies value = length value >= 2

ledgerValue :: LedgerValue -> V3.Value
ledgerValue policies =
  Value.Value $
    Map.unsafeFromList
      [ (currencySymbol, Map.unsafeFromList tokens)
      | (currencySymbol, tokens) <- policies
      ]

ledgerTxOutValueData :: V3.Value -> BuiltinData
ledgerTxOutValueData value =
  BI.head $ BI.tail fields
  where
    encodedTxOut = V3.toBuiltinData (mkTxOut (withTxOutValue value))
    fields = BI.snd (BI.unsafeDataAsConstr encodedTxOut)

ledgerValueCoverage :: V3.Value -> V3.Value -> Bool
ledgerValueCoverage required paid =
  builtinBoolToBool $
    valueCoversData (ledgerTxOutValueData required) (ledgerTxOutValueData paid)

ledgerValueCoverageV2 :: V3.Value -> V3.Value -> Bool
ledgerValueCoverageV2 required paid =
  builtinBoolToBool $
    V2Global.valueCoversData (ledgerTxOutValueData required) (ledgerTxOutValueData paid)

assertLedgerValueCoverage :: Bool -> V3.Value -> V3.Value -> IO ()
assertLedgerValueCoverage expected required paid = do
  (required `Value.leq` paid) @?= expected
  ledgerValueCoverage required paid @?= expected
  ledgerValueCoverageV2 required paid @?= expected

policyA :: V3.CurrencySymbol
policyA = V3.CurrencySymbol "1111111111111111111111111111"

policyB :: V3.CurrencySymbol
policyB = V3.CurrencySymbol "2222222222222222222222222222"

policyC :: V3.CurrencySymbol
policyC = V3.CurrencySymbol "3333333333333333333333333333"

tokenA :: V3.TokenName
tokenA = V3.TokenName "a"

baseScriptHash :: V3.ScriptHash
baseScriptHash = V3.ScriptHash "reclaim-base"

paramCurrencySymbol :: V3.CurrencySymbol
paramCurrencySymbol = V3.CurrencySymbol "param-policy"

paramTokenName :: V3.TokenName
paramTokenName = V3.TokenName "RECLAIMPARAMS"

validBaseDatum :: ReclaimBaseDatum
validBaseDatum = ReclaimBaseDatum goldenPaymentKeyHash

invalidBaseDatum :: ReclaimBaseDatum
invalidBaseDatum = ReclaimBaseDatum "short"

reclaimValue :: V3.Value
reclaimValue = V3.singleton V3.adaSymbol V3.adaToken 2000000

aggregateTwoReclaimValue :: V3.Value
aggregateTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 4000000

underpaidTwoReclaimValue :: V3.Value
underpaidTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 3999999

overpaidTwoReclaimValue :: V3.Value
overpaidTwoReclaimValue =
  V3.singleton V3.adaSymbol V3.adaToken 5000000

multiAssetReclaimValue :: V3.Value
multiAssetReclaimValue =
  reclaimValue <> V3.singleton otherSymbol otherTokenName 5

mintValue :: [(V3.CurrencySymbol, [(V3.TokenName, Integer)])] -> V3.Value
mintValue entries =
  mconcat
    [ V3.singleton currencySymbol tokenName' amount
    | (currencySymbol, tokens) <- entries
    , (tokenName', amount) <- tokens
    ]

mintingContext :: [V3.TxOutRef] -> V3.Value -> V3.ScriptContext
mintingContext inputs minted =
  buildScriptContext $
    foldMap (withTxIn . txIn) inputs
      <> withMintValue minted
      <> withMintingPolicy ownSymbol (V3.toBuiltinData ())

reclaimBaseContext :: Maybe ReclaimBaseDatum -> [(V3.Credential, V3.Lovelace)] -> V3.ScriptContext
reclaimBaseContext datum withdrawals =
  buildScriptContext $
    foldMap (uncurry withWithdrawal) withdrawals
      <> withSpendingScript
        (V3.toBuiltinData ())
        ( withOutRef seedRef
            <> withAddress (scriptAddress baseScriptHash)
            <> maybe mempty (withInlineDatum . V3.toBuiltinData) datum
        )

reclaimGlobalContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalContext proof paramsIdx inputs refs =
  reclaimGlobalContextWithProofs [proof] paramsIdx inputs refs

reclaimGlobalContextWithProofs ::
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalContextWithProofs proofs paramsIdx inputs refs =
  reclaimGlobalContextWithOutputs proofs paramsIdx inputs refs (replicate (length proofs) singleDestinationOutput)

reclaimGlobalContextWithOutputs ::
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalContextWithOutputs proofs paramsIdx inputs refs outputs =
  reclaimGlobalContextWithOutputsAt proofs paramsIdx 0 inputs refs outputs

reclaimGlobalContextWithOutputsAt ::
  [BuiltinByteString] ->
  Integer ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalContextWithOutputsAt proofs paramsIdx destinationOutStartIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        (reclaimGlobalRedeemerData paramsIdx destinationOutStartIdx proofs)
        globalCredential
        0

reclaimGlobalContextWithRawProofs ::
  [BuiltinData] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalContextWithRawProofs proofs paramsIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        ( BI.mkConstr
            0
            ( BI.mkCons
                (BI.mkI paramsIdx)
                ( BI.mkCons
                    (BI.mkI 0)
                    ( BI.mkCons
                        (BI.mkList (rawBuiltinDataList proofs))
                        (BI.mkNilData BI.unitval)
                    )
                )
            )
        )
        globalCredential
        0

reclaimGlobalStatementV2ContextWithOutputs ::
  [BuiltinByteString] ->
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalStatementV2ContextWithOutputs proofs publicInputDigests paramsIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        (StatementV2.reclaimGlobalRedeemerDataV2 paramsIdx 0 proofs publicInputDigests)
        globalCredential
        0

proofSlotData :: [BuiltinByteString] -> BI.BuiltinList BuiltinData
proofSlotData =
  rawBuiltinDataList . fmap BI.mkB

rawBuiltinDataList :: [BuiltinData] -> BI.BuiltinList BuiltinData
rawBuiltinDataList =
  foldr BI.mkCons (BI.mkNilData BI.unitval)

reclaimGlobalSpendingContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalSpendingContext proof paramsIdx inputs refs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> withTxOut singleDestinationOutput
      <> withSpendingScript
        (reclaimGlobalRedeemerData paramsIdx 0 [proof])
        ( withOutRef otherRef
            <> withAddress (scriptAddress globalScriptHash)
            <> withValue reclaimValue
            <> withInlineDatum (V3.toBuiltinData ())
        )

reclaimGlobalMintingContext ::
  BuiltinByteString ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  V3.ScriptContext
reclaimGlobalMintingContext proof paramsIdx inputs refs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> withTxOut singleDestinationOutput
      <> withMintingScript
        (V3.singleton ownSymbol tokenName 1)
        (reclaimGlobalRedeemerData paramsIdx 0 [proof])

reclaimGlobalMultiContext ::
  BuiltinByteString ->
  Integer ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalMultiContext proof paramsIdx destinationIdx inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript
        (reclaimGlobalMultiRedeemerData paramsIdx destinationIdx proof)
        globalCredential
        0

pubKeyOutput :: BuiltinByteString -> V3.Value -> V3.TxOut
pubKeyOutput paymentKeyHash value =
  mkTxOut $
    withTxOutAddress (pubKeyAddress (V3.PubKeyHash paymentKeyHash))
      <> withTxOutValue value

txIn :: V3.TxOutRef -> V3.TxInInfo
txIn ref =
  mkInput $
    withOutRef ref
      <> withAddress (pubKeyAddress (V3.PubKeyHash "owner"))

reclaimBaseInput :: V3.TxInInfo
reclaimBaseInput = reclaimBaseInputAt "base" 0

secondReclaimBaseInput :: V3.TxInInfo
secondReclaimBaseInput = reclaimBaseInputAt "base-2" 1

differentOwnerReclaimBaseInput :: V3.TxInInfo
differentOwnerReclaimBaseInput =
  reclaimBaseInputAtWithDatum "base-different" 1 (ReclaimBaseDatum secondPaymentKeyHash)

thirdOwnerReclaimBaseInput :: V3.TxInInfo
thirdOwnerReclaimBaseInput =
  reclaimBaseInputAtWithDatum "base-third" 1 (ReclaimBaseDatum thirdPaymentKeyHash)

multiAssetReclaimBaseInput :: V3.TxInInfo
multiAssetReclaimBaseInput =
  reclaimBaseInputAtWithValueAndDatum "base-token" 0 multiAssetReclaimValue validBaseDatum

reclaimBaseInputWithDatum :: ReclaimBaseDatum -> V3.TxInInfo
reclaimBaseInputWithDatum datum =
  reclaimBaseInputAtWithDatum "base-invalid" 0 datum

reclaimBaseInputAt :: BuiltinByteString -> Integer -> V3.TxInInfo
reclaimBaseInputAt txId idx =
  reclaimBaseInputAtWithDatum txId idx validBaseDatum

reclaimBaseInputAtWithDatum :: BuiltinByteString -> Integer -> ReclaimBaseDatum -> V3.TxInInfo
reclaimBaseInputAtWithDatum txId idx datum =
  reclaimBaseInputAtWithValueAndDatum txId idx reclaimValue datum

reclaimBaseInputAtWithValueAndDatum ::
  BuiltinByteString ->
  Integer ->
  V3.Value ->
  ReclaimBaseDatum ->
  V3.TxInInfo
reclaimBaseInputAtWithValueAndDatum txId idx value datum =
  mkInput $
    withOutRef
      ( V3.TxOutRef
        { V3.txOutRefId = V3.TxId txId
        , V3.txOutRefIdx = idx
        }
      )
      <> withAddress (scriptAddress baseScriptHash)
      <> withValue value
      <> withInlineDatum (V3.toBuiltinData datum)

paramInput :: V3.TxInInfo
paramInput =
  paramInputWithValue (V3.singleton paramCurrencySymbol paramTokenName 1)

paramInputWithValue :: V3.Value -> V3.TxInInfo
paramInputWithValue value =
  paramInputWithValueAt "params" 0 value

paramInputWithValueAt :: BuiltinByteString -> Integer -> V3.Value -> V3.TxInInfo
paramInputWithValueAt txId idx value =
  mkInput $
    paramInputBuilderAt txId idx
      <> withValue (paramAdaValue <> value)
      <> withInlineDatum
        (reclaimGlobalParamsData baseScriptHash)

paramInputWithoutDatum :: V3.TxInInfo
paramInputWithoutDatum =
  mkInput $
    paramInputBuilder
      <> withValue (paramAdaValue <> V3.singleton paramCurrencySymbol paramTokenName 1)

paramInputBuilder :: InputBuilder
paramInputBuilder =
  paramInputBuilderAt "params" 0

paramInputBuilderAt :: BuiltinByteString -> Integer -> InputBuilder
paramInputBuilderAt txId idx =
  withOutRef
    ( V3.TxOutRef
      { V3.txOutRefId = V3.TxId txId
      , V3.txOutRefIdx = idx
      }
    )
    <> withAddress (scriptAddress (V3.ScriptHash "always-fails"))

paramAdaValue :: V3.Value
paramAdaValue =
  V3.singleton V3.adaSymbol V3.adaToken 2000000

baseScriptHashBytes :: BuiltinByteString
baseScriptHashBytes =
  case baseScriptHash of
    V3.ScriptHash rawHash -> rawHash

txInListData :: [V3.TxInInfo] -> BI.BuiltinList BuiltinData
txInListData =
  BI.unsafeDataAsList . V3.toBuiltinData

txOutListData :: [V3.TxOut] -> BI.BuiltinList BuiltinData
txOutListData =
  BI.unsafeDataAsList . V3.toBuiltinData

proofMatches ::
  Integer ->
  BuiltinByteString ->
  BuiltinByteString ->
  Integer ->
  BuiltinByteString ->
  BuiltinByteString ->
  Bool
proofMatches expectedCount expectedCredentials expectedDestination actualCount actualCredentials actualDestination =
  actualCount == expectedCount
    && actualCredentials == expectedCredentials
    && actualDestination == expectedDestination

proofMatchesActual :: Integer -> BuiltinByteString -> BuiltinByteString -> Bool
proofMatchesActual _ _ _ = True

zeroBytes :: Int -> BuiltinByteString
zeroBytes count =
  bytesToBuiltin (replicate count 0)

destinationAddressBytesFor :: BuiltinByteString -> BuiltinByteString
destinationAddressBytesFor paymentKeyHash =
  bytesToBuiltin [1] <> paymentKeyHash <> bytesToBuiltin [0] <> zeroBytes 28

destinationAddressBytes :: BuiltinByteString
destinationAddressBytes =
  destinationAddressBytesFor destinationPaymentKeyHash

twoCredentialBytes :: BuiltinByteString
twoCredentialBytes =
  goldenPaymentKeyHash <> secondPaymentKeyHash

singleDestinationOutput :: V3.TxOut
singleDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash reclaimValue

underpaidSingleDestinationOutput :: V3.TxOut
underpaidSingleDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash (V3.singleton V3.adaSymbol V3.adaToken 1999999)

changedSingleDestinationOutput :: V3.TxOut
changedSingleDestinationOutput =
  pubKeyOutput thirdPaymentKeyHash reclaimValue

exactDestinationOutput :: V3.TxOut
exactDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash aggregateTwoReclaimValue

splitDestinationOutputs :: [V3.TxOut]
splitDestinationOutputs =
  [ pubKeyOutput destinationPaymentKeyHash reclaimValue
  , pubKeyOutput destinationPaymentKeyHash reclaimValue
  ]

splitDestinationOutputsWithGap :: [V3.TxOut]
splitDestinationOutputsWithGap =
  [ pubKeyOutput destinationPaymentKeyHash reclaimValue
  , changedDestinationOutput
  , pubKeyOutput destinationPaymentKeyHash reclaimValue
  ]

underpaidDestinationOutput :: V3.TxOut
underpaidDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash underpaidTwoReclaimValue

overpaidDestinationOutput :: V3.TxOut
overpaidDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash overpaidTwoReclaimValue

changedDestinationOutput :: V3.TxOut
changedDestinationOutput =
  pubKeyOutput thirdPaymentKeyHash aggregateTwoReclaimValue

missingNativeAssetDestinationOutput :: V3.TxOut
missingNativeAssetDestinationOutput =
  pubKeyOutput destinationPaymentKeyHash overpaidTwoReclaimValue
