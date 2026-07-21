{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

module Main (main) where

import Control.Exception (SomeException, evaluate, try)
import Control.Monad (forM_)
import Data.Char (digitToInt, isHexDigit)
import Data.List (nubBy, zipWith4)

import qualified PlutusCore as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
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
  , verifyOwnershipDestinationWithParsedVKKnown28NoPok
  , verifyCommittedProofMergedWithVK
  , verifyCommittedProofPokBatch
  , verifyOwnershipWithVK
  )
import qualified PlutusLedgerApi.V3 as V3
import ReclaimBaseOracle (reclaimBaseValidatorOracle)
import ScriptContextBuilder
import System.Exit (ExitCode (ExitFailure))
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
  [ (971923317177279104696445163957359688603141178563892274304415630153150620008, 1, 30143205349673303924038740226444575063052729468321387927570779271358684740710, 39234791792570413723461239854507960256910086163474480893678363808079511326207)
  , (6185711955495340858609794866302178511720112464752392346501595720762008003062, 6185711955495340858609794866302178511720112464752392346501595720762008003063, 45675770430195617894998800070589506844327031987561357950086254326376367079086, 25786663917967831888009864530184787489742174014649030067927744084196421265168)
  , (34138887377808395603384512789926079199329098514160463655105070377581579330927, 8331685811063389499885915231465427448168899038554601823500490310276358610632, 15934858627848114165623487994537679187039612408714501015116680999416582956046, 8454467585621254023424771275410613100767605678347115784234346645352002658108)
  , (4050223649621952002893595634446234594930487798482185631130611749910858005088, 41799547642784208862480269318929996820721349195551639762915557832399871167963, 17649722512999231249500714495616807677063212623907778565865360782004086093631, 46359785802671086012403640538480516415065145731297601403076984750260122287013)
  , (19412359996798938220956335213928230805118296267944318495706436628675030399339, 43111173811257102588193817507451208554052154719559573183577577355015017512519, 33870028047050484931424665247853027771852982096336211727828296267850146765768, 11790268529377436190119245658241540741457879385721931765982852769191648513136)
  , (20408575888598363472074565533343346233650921066493644253234235177544607757237, 23503706297217456716252376843778474386831402656596089862165390917578226273549, 22758881971505448432558392706152000198335364978117121033584575808251427722287, 31642004732034419122469584493237329613967213972131674137279477063596969466721)
  , (1798154814053191814673675094630726133966691227209037801793217750533554170715, 23540052811365506733268996157123482851850172370880410673415625202779070649460, 43429006371487139155772788962368599530646571065816866097018277631863101142236, 66491749857469224189329191298909567256418651152250996157723511154399292912)
  , (17429327968848838354173297802306428513733999120619034431253556411933158794297, 49358161649994204865730070606441017630069309847630576157765577877925870379296, 21673031299103894338042973667441471770581287634887008546302843392695021473049, 39003710787239659322167481374543680233735483060007793929213729722179617098157)
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

applyContextArgument :: Script -> V3.ScriptContext -> Script
applyContextArgument (UPLC.Program ann version term) ctx =
  UPLC.Program ann version $
    PLC.mkIterAppNoAnn term [PLC.mkConstant () (V3.toData ctx)]

unlimitedBudget :: ExBudget
unlimitedBudget = ExBudget (ExCPU maxBound) (ExMemory maxBound)

protocolVersion :: V3.MajorProtocolVersion
protocolVersion = V3.MajorProtocolVersion 11

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
                  @?= 6185711955495340858609794866302178511720112464752392346501595720762008003062
                ownershipProofBatchChallenge (proof2 <> proof1)
                  @?= 528934552180871285474883085374963170932246311028689964823874044044330916369
                ownershipProofBatchChallenge (flipFirstBit proof1 <> proof2)
                  @?= 2240230196849817819172518376912252901795319243174045708068785302118221208191
                ownershipProofBatchChallenge (proof1 <> proof1)
                  @?= 32033878854358701438938469552727779661760405153761709520200384168200448811399
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
        [ testCase "accepts when the configured withdrawal is present" $
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
        , testCase "ignores a missing datum because GlobalV2 owns datum validation" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext Nothing [(globalCredential, 0)])
              @?= True
        , testCase "ignores datum credential width because GlobalV2 owns proof input validation" $
            reclaimBaseValidatorOracle globalCredential (reclaimBaseContext (Just invalidBaseDatum) [(globalCredential, 0)])
              @?= True
        , testCase "does not revalidate the deployment credential constructor" $
            reclaimBaseValidatorOracle keyGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(keyGlobalCredential, 0)])
              @?= True
        , testCase "raw validator accepts the golden inline datum with multiple mixed withdrawals" $
            runCompiledReclaimBase
              globalCredential
              ( reclaimBaseContext
                  (Just validBaseDatum)
                  [(keyGlobalCredential, 4), (otherGlobalCredential, 9), (globalCredential, 1234567)]
              )
              @?= True
        , testGroup "raw validator ignores datum lengths" $
            [ testCase ("length " <> show datumLength) $
                runCompiledReclaimBase
                  globalCredential
                  (reclaimBaseContextForDatum (DatumInlineWrongLength datumLength) [(globalCredential, 0)])
                  @?= True
            | datumLength <- [0, 5, 27, 29, 64]
            ]
        , testGroup "raw validator ignores malformed inline datum encodings" $
            [ testCase label $
                runCompiledReclaimBase
                  globalCredential
                  (reclaimBaseContextForDatum datumMode [(globalCredential, 0)])
                  @?= True
            | (label, datumMode) <-
                [ ("wrong constructor", DatumInlineWrongConstructor)
                , ("missing constructor field", DatumInlineNoFields)
                , ("non-bytes credential field", DatumInlineNonBytesField)
                ]
            ]
        , testCase "raw validator ignores trailing datum fields" $
            runCompiledReclaimBase
              globalCredential
              (reclaimBaseContextForDatum DatumInlineExtraField [(globalCredential, 0)])
              @?= True
        , testCase "raw validator ignores a missing datum" $
            runCompiledReclaimBase globalCredential (reclaimBaseContext Nothing [(globalCredential, 0)])
              @?= True
        , testCase "raw validator ignores datum-by-hash" $
            runCompiledReclaimBase globalCredential (reclaimBaseContextForDatum DatumByHash [(globalCredential, 0)])
              @?= True
        , testCase "raw validator rejects an absent withdrawal" $
            runCompiledReclaimBase globalCredential (reclaimBaseContext (Just validBaseDatum) [(otherGlobalCredential, 0)])
              @?= False
        , testCase "raw validator rejects a wrong configured global credential" $
            runCompiledReclaimBase otherGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)])
              @?= False
        , testCase "raw validator accepts a key-shaped configured credential when present" $
            runCompiledReclaimBase keyGlobalCredential (reclaimBaseContext (Just validBaseDatum) [(keyGlobalCredential, 0)])
              @?= True
        , testGroup "raw validator ignores ScriptInfo purpose" $
            [ testCase label $
                runCompiledReclaimBase
                  globalCredential
                  (withBasePurpose purpose (reclaimBaseContext (Just validBaseDatum) [(globalCredential, 0)]))
                  @?= True
            | (label, purpose) <-
                [ ("MintingScript", PurposeMinting)
                , ("RewardingScript", PurposeRewarding)
                , ("CertifyingScript", PurposeCertifying)
                , ("VotingScript", PurposeVoting)
                , ("ProposingScript", PurposeProposing)
                ]
            ]
        , testCase "plutus-ledger-api 1.38 fixed TxInfo projection selects txInfoWdrl field 6" $ do
            let ctx =
                  reclaimBaseContext
                    (Just validBaseDatum)
                    [(keyGlobalCredential, 3), (globalCredential, 7), (otherGlobalCredential, 11)]
                expectedWdrl = V3.toBuiltinData (V3.txInfoWdrl (V3.scriptContextTxInfo ctx))
                projectedWdrl = txInfoWdrlFromContextData (V3.toBuiltinData ctx)
            B.equalsData projectedWdrl expectedWdrl @?= True
        -- Stage 2b acceptance-equivalence qualification: configure at least
        -- 5,000 successes; checkCoverage may run more for confidence.
        , localOption (QC.QuickCheckTests 5000) $
            QC.testProperty "raw projection matches the withdrawal-only oracle on randomized well-formed contexts" $
              QC.forAllShrink
                genReclaimBaseDifferentialCase
                shrinkReclaimBaseDifferentialCase
                reclaimBaseDifferentialProperty
        ]
    , testGroup "ReclaimGlobalMulti benchmark-only merged finalVerify"
        [ testCase "M3/M4 Multi paired corpus and eager-vkX wiring mutations reject" $ do
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
              @?= bytesToBuiltin (decodeHex "75efd931d9ddf338bc58880ba5b042b2115d75b608f4bd72c22165b516bc4fc2")
            ownershipProofBatchChallengeV2 transcript
              @?= 908503580536723318674402094080487594791423671977714076978685087528917946307
            ownershipProofBatchMergeChallengeV2 transcript
              @?= 44262786702551963121691503326809832232322836267413292930891251623326440559893
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
                  @?= bytesToBuiltin (decodeHex "53a3777b2f0bf2c9961b50eb0e243cbedaf7f8b367131607f22a9fa9e4604791")
                ownershipProofBatchChallengeV2 distinctTranscript
                  @?= 37830787132813288007666968507575178910493244800430188426869315086352656648082
                ownershipProofBatchMergeChallengeV2 distinctTranscript
                  @?= 38698140857556389275494025163187574286523348578132235522359358935216587054255
                B.blake2b_256 repeatedTranscript
                  @?= bytesToBuiltin (decodeHex "6d50762f7c6916531a4b11abf0b326b4a1d63bedf7013a2c6a791d48cd0e25bc")
                ownershipProofBatchChallengeV2 repeatedTranscript
                  @?= 49444263947046676257477883784954335478091752096716344371034914418851304056253
                ownershipProofBatchMergeChallengeV2 repeatedTranscript
                  @?= 47121016413796753695864927528822041120076087371690331019547667634862789403
                B.blake2b_256 multiTranscript
                  @?= bytesToBuiltin (decodeHex "59b22d408d6c4965eb78632c959557811f00d99969b28ccddfba0012753cff71")
                ownershipProofBatchChallengeV2 multiTranscript
                  @?= 40570654620357032943455514758320935667228665531329494875443015168245154774898
                ownershipProofBatchMergeChallengeV2 multiTranscript
                  @?= 8636757789949591304714306246332989594687787538241662237540073471059061109757
              _ -> assertFailure "distinct fixture file has fewer than two rows"
        , testCase "transcript framing trusts the deployment-checked verifier-key-hash width" $ do
            let transcriptProof = destinationProof
                digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
            forM_
              [ B.sliceByteString 0 31 (B.blake2b_256 destinationVk)
              , B.blake2b_256 destinationVk <> B.consByteString 0 B.emptyByteString
              ] $ \verifierKeyHash ->
                StatementV2.reclaimBatchTranscriptV2
                    verifierKeyHash
                    (proofSlotData [transcriptProof])
                    (proofSlotData [digest])
                  @?= ownershipProofBatchDomainV2
                    <> verifierKeyHash
                    <> B.integerToByteString BigEndian 2 1
                    <> transcriptProof
                    <> digest
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
        , testCase "accepts noncanonical redeemer tags and trailing fields" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                context redeemer =
                  reclaimGlobalStatementV2ContextWithRedeemerData
                    redeemer
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
                nonzeroTag =
                  reclaimGlobalStatementV2RedeemerDataWithEnvelope
                    7 [] [destinationProof] [digest]
                trailingField =
                  reclaimGlobalStatementV2RedeemerDataWithEnvelope
                    0 [BI.mkI 99] [destinationProof] [digest]
            nonzeroAccepted <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context nonzeroTag)
            trailingAccepted <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context trailingField)
            let (nonzeroCompiledAccepted, _) =
                  evaluateCompiledScript
                    (compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash)
                    (context nonzeroTag)
                (trailingCompiledAccepted, _) =
                  evaluateCompiledScript
                    (compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash)
                    (context trailingField)
            nonzeroAccepted @?= True
            trailingAccepted @?= True
            nonzeroCompiledAccepted @?= True
            trailingCompiledAccepted @?= True
        , testCase "rejects deregistration-purpose invocation to preserve the rewarding credential lifecycle" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                validContext =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [digest]
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
            accepted <- safeBool $
              runReclaimGlobalStatementV2
                destinationVk
                verifierKeyHash
                (withReclaimGlobalDeregistrationPurpose validContext)
            let (compiledAccepted, _) =
                  evaluateCompiledScript
                    (compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash)
                    (withReclaimGlobalDeregistrationPurpose validContext)
            accepted @?= False
            compiledAccepted @?= False
        , testCase "accepts parameter outputs carrying unrelated native assets" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                context value =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [digest]
                    0
                    [reclaimBaseInput]
                    [paramInputWithValue value]
                    [singleDestinationOutput]
                samePolicyExtra =
                  V3.singleton paramCurrencySymbol paramTokenName 1
                    <> V3.singleton paramCurrencySymbol otherTokenName 1
                otherPolicyExtra =
                  V3.singleton paramCurrencySymbol paramTokenName 1
                    <> V3.singleton otherSymbol otherTokenName 1
            samePolicyAccepted <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context samePolicyExtra)
            otherPolicyAccepted <- safeBool $
              runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context otherPolicyExtra)
            let (samePolicyCompiledAccepted, _) =
                  evaluateCompiledScript
                    (compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash)
                    (context samePolicyExtra)
                (otherPolicyCompiledAccepted, _) =
                  evaluateCompiledScript
                    (compiledReclaimGlobalStatementV2Script destinationVk verifierKeyHash)
                    (context otherPolicyExtra)
            samePolicyAccepted @?= True
            otherPolicyAccepted @?= True
            samePolicyCompiledAccepted @?= True
            otherPolicyCompiledAccepted @?= True
        , testCase "rejects malformed proof/digest widths, list misalignment, and digest substitutions" $ do
            let verifierKeyHash = B.blake2b_256 destinationVk
                actualDigest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                wrongDigest = flipFirstBit actualDigest
                context proofs digests =
                  reclaimGlobalStatementV2ContextWithOutputs proofs digests 0 [reclaimBaseInput] [paramInput] [singleDestinationOutput]
            shortProof <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [B.sliceByteString 0 335 destinationProof] [actualDigest])
            longProof <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof <> B.consByteString 0 B.emptyByteString] [actualDigest])
            shortDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [B.sliceByteString 0 31 actualDigest])
            longDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [actualDigest <> B.consByteString 0 B.emptyByteString])
            substitutedDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [wrongDigest])
            missingDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [])
            extraDigest <- safeBool $ runReclaimGlobalStatementV2 destinationVk verifierKeyHash (context [destinationProof] [actualDigest, actualDigest])
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
            let canonicalHash = "06ce913c931a53561fe5d022ed45a5fbc033b06d80eebdd9f646d23a05b7d5c4"
                wrongHash = (if head canonicalHash == '0' then '1' else '0') : tail canonicalHash
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
        , testCase "compiled V2 script rejects malformed verifier-key widths" $ do
            let digest = ownershipDestinationPublicInputDigest goldenPaymentKeyHash destinationAddressBytes
                ctx =
                  reclaimGlobalStatementV2ContextWithOutputs
                    [destinationProof]
                    [digest]
                    0
                    [reclaimBaseInput]
                    [paramInput]
                    [singleDestinationOutput]
            forM_
              [ ("671-byte verifier key", B.sliceByteString 0 671 destinationVk, B.blake2b_256 (B.sliceByteString 0 671 destinationVk))
              , ("673-byte verifier key", destinationVk <> B.consByteString 0 B.emptyByteString, B.blake2b_256 (destinationVk <> B.consByteString 0 B.emptyByteString))
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

reclaimGlobalDeregistrationCertificate :: V3.TxCert
reclaimGlobalDeregistrationCertificate =
  V3.TxCertUnRegStaking globalCredential Nothing

withReclaimGlobalDeregistrationPurpose :: V3.ScriptContext -> V3.ScriptContext
withReclaimGlobalDeregistrationPurpose ctx =
  ctx
    { V3.scriptContextTxInfo =
        (V3.scriptContextTxInfo ctx)
          { V3.txInfoTxCerts = [reclaimGlobalDeregistrationCertificate]
          }
    , V3.scriptContextScriptInfo =
        V3.CertifyingScript 0 reclaimGlobalDeregistrationCertificate
    }

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

reclaimGlobalStatementV2ContextWithOutputs ::
  [BuiltinByteString] ->
  [BuiltinByteString] ->
  Integer ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalStatementV2ContextWithOutputs proofs publicInputDigests paramsIdx inputs refs outputs =
  reclaimGlobalStatementV2ContextWithRedeemerData
    (StatementV2.reclaimGlobalRedeemerDataV2 paramsIdx 0 proofs publicInputDigests)
    inputs
    refs
    outputs

reclaimGlobalStatementV2ContextWithRedeemerData ::
  BuiltinData ->
  [V3.TxInInfo] ->
  [V3.TxInInfo] ->
  [V3.TxOut] ->
  V3.ScriptContext
reclaimGlobalStatementV2ContextWithRedeemerData redeemer inputs refs outputs =
  buildScriptContext $
    foldMap withTxIn inputs
      <> foldMap withReferenceTxIn refs
      <> foldMap withTxOut outputs
      <> withRewardingScript redeemer globalCredential 0

reclaimGlobalStatementV2RedeemerDataWithEnvelope ::
  Integer ->
  [BuiltinData] ->
  [BuiltinByteString] ->
  [BuiltinByteString] ->
  BuiltinData
reclaimGlobalStatementV2RedeemerDataWithEnvelope constructorTag trailingFields proofs publicInputDigests =
  BI.mkConstr constructorTag $
    rawBuiltinDataList $
      [ BI.mkI 0
      , BI.mkI 0
      , BI.mkList (proofSlotData proofs)
      , BI.mkList (proofSlotData publicInputDigests)
      ] <> trailingFields

proofSlotData :: [BuiltinByteString] -> BI.BuiltinList BuiltinData
proofSlotData =
  rawBuiltinDataList . fmap BI.mkB

rawBuiltinDataList :: [BuiltinData] -> BI.BuiltinList BuiltinData
rawBuiltinDataList =
  foldr BI.mkCons (BI.mkNilData BI.unitval)

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
        (StatementV2.reclaimGlobalParamsData baseScriptHash)

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
