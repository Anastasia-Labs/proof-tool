// Japanese copy is intentionally keyed by the reviewed English UI message.
// Unknown strings pass through unchanged so wallet names, addresses, hashes,
// asset names, protocol identifiers, and backend diagnostics are never altered.
const exactMessages: Record<string, string> = {
  // Shared shell and navigation.
  "Cardano ownership recovery": "Cardano所有権リカバリー",
  Main: "メイン",
  Help: "ヘルプ",
  English: "English",
  Japanese: "日本語",
  "Lock funds": "資金をロック",
  "Lock / Donate funds": "資金をロック・寄付",
  "Claim funds": "資金を請求",
  "Claim progress": "請求の進行状況",
  "Lock / Donate funds progress": "資金のロック・寄付の進行状況",
  "Verify service": "サービスを確認",
  "Impacted wallet": "被害を受けたウォレット",
  "Available claims": "請求可能な資金",
  "Safe wallet": "安全なウォレット",
  "Create proofs": "証明を作成",
  "Claim review": "請求結果",
  "Cardano mainnet": "Cardanoメインネット",
  Pinned: "固定済み",
  "Single validator": "単一バリデーター",
  Fixture: "テスト表示",
  Pending: "未完了",
  Active: "進行中",
  "In progress": "進行中",
  Complete: "完了",
  Completed: "完了",
  Ready: "準備完了",
  Running: "実行中",
  Waiting: "待機中",
  Checking: "確認中",
  Unavailable: "利用不可",
  Generated: "作成済み",
  Generating: "作成中",
  Confirmed: "確認済み",
  Submitted: "送信済み",
  "Not connected": "未接続",
  "Not connected yet": "まだ接続されていません",
  "Not required": "不要",
  "Needs attention": "確認が必要",
  "Secured by an on-chain smart contract — no one, including us, can move funds without the owner's proof.":
    "オンチェーンのスマートコントラクトで保護されています。所有者の証明なしに、当サービスを含む誰も資金を移動できません。",
  "Secured by an on-chain smart contract — no one, including us, can move funds without the owner’s proof.":
    "オンチェーンのスマートコントラクトで保護されています。所有者の証明なしに、当サービスを含む誰も資金を移動できません。",

  // Landing page.
  "Recovery paths": "リカバリー方法",
  "Recovery guarantees": "リカバリーの安全性",
  "Recover funds from a compromised Cardano wallet": "侵害されたCardanoウォレットから資金を取り戻す",
  "If your wallet was compromised, your funds may have been rescued and locked for you. Prove you’re the original owner — on your own device — and claim them. Your recovery phrase never leaves your device.":
    "ウォレットが侵害された場合でも、資金が救出され、あなたのためにロックされている可能性があります。元の所有者であることを自分の端末上で証明して、資金を請求できます。リカバリーフレーズが端末の外へ送信されることはありません。",
  "Funds were taken from me": "資金を奪われた方",
  "Funds were taken from me — prove ownership and claim what was locked for you":
    "所有権を証明し、あなたのためにロックされた資金を請求します",
  "I’m a rescuer or donor — lock funds only the original owner can claim":
    "救出者・寄付者として、元の所有者だけが請求できるよう資金をロックします",
  "Your recovery phrase stays on your device": "リカバリーフレーズは端末内に保持",
  "Proofs are generated locally, nothing is uploaded": "証明は端末上で作成され、何もアップロードされません",
  "No account or signup": "アカウント登録不要",
  "Connect a wallet, prove, claim": "ウォレットを接続し、証明して請求",
  "Open source": "オープンソース",
  "Contracts and prover are public on GitHub": "コントラクトと証明プログラムをGitHubで公開",
  "How it works": "仕組み",
  "Connect the affected wallet": "被害を受けたウォレットを接続",
  "Read-only — used to find funds locked for you": "読み取り専用で、あなたのためにロックされた資金を検索します",
  "Prove ownership locally": "端末上で所有権を証明",
  "Your recovery phrase is used only on your device": "リカバリーフレーズはお使いの端末上でのみ使用されます",
  "Claim to a safe wallet": "安全なウォレットへ請求",
  "Funds are released to a wallet you control": "管理下にあるウォレットへ資金が送られます",
  "Lock / Donate creates funds only the original owner can claim": "ロック・寄付した資金は元の所有者だけが請求できます",
  "Locking places funds in an owner-bound UTxO on Cardano. Use it after sweeping from compromised credentials, or to donate in a way an attacker cannot claim without the original owner’s proof.":
    "資金をCardano上の所有者に紐づくUTxOへロックします。侵害された認証情報から資金を救出した後や、攻撃者が元の所有者の証明なしに受け取れない形で寄付する場合に使用します。",
  "Open lock / donate flow": "ロック・寄付画面を開く",
  "The proof reveals nothing about your keys": "証明から鍵の情報が漏れることはありません",
  "You’ll need the recovery phrase for the affected wallet. It is used only on your device to prove the compromised payment credential can be derived from your key — the phrase itself is never uploaded, and the proof cannot be used to spend from your wallet.":
    "被害を受けたウォレットのリカバリーフレーズが必要です。侵害された支払い認証情報があなたの鍵から導出できることを証明するため、端末上でのみ使用されます。フレーズ自体はアップロードされず、この証明を使ってウォレットから支払うこともできません。",
  "View source on GitHub": "GitHubでソースを見る",
  Documentation: "ドキュメント",
  "Built for Cardano mainnet": "Cardanoメインネット対応",

  // Claim flow: common actions and summaries.
  Back: "戻る",
  Previous: "前へ",
  Next: "次へ",
  Continue: "続行",
  Done: "完了",
  Cancel: "キャンセル",
  Refresh: "更新",
  "Refresh status": "状態を更新",
  "Try again": "再試行",
  "Go back": "戻る",
  "Start over": "最初からやり直す",
  Resume: "再開",
  "Choose another wallet": "別のウォレットを選択",
  "Choose a different wallet": "別のウォレットを選択",
  "Continue to safe wallet": "安全なウォレットへ進む",
  "Continue to current batch": "現在のバッチへ進む",
  "Connect impacted wallet": "被害を受けたウォレットを接続",
  "Connect safe wallet": "安全なウォレットを接続",
  "Generate proofs": "証明を作成",
  "Generating proofs": "証明を作成中",
  "Retry proofs": "証明作成を再試行",
  "Retry signature": "署名を再試行",
  "Retry deployment": "デプロイ情報を再取得",
  "Start another recovery": "別のリカバリーを開始",
  "Download CSV": "CSVをダウンロード",
  "Copy summary": "概要をコピー",
  Copied: "コピーしました",
  View: "表示",
  Actions: "操作",
  Action: "操作",
  Review: "確認",
  Transaction: "トランザクション",
  Receipt: "受領記録",
  Network: "ネットワーク",
  Deployment: "デプロイ",
  "Pinned source": "固定されたソース",
  "Git commit": "Gitコミット",
  "View commit on GitHub": "GitHubでコミットを確認",
  "Technical details": "技術情報",
  "Claim flow": "請求フロー",
  "Claim draft": "請求ドラフト",
  "Claim plan": "請求プラン",
  "Proof plan": "証明プラン",
  "Current batch": "現在のバッチ",
  "Next claim batch": "次の請求バッチ",
  "Batch size": "バッチサイズ",
  "Default batch size": "標準バッチサイズ",
  "Estimated batches": "推定バッチ数",
  "Estimated claim transactions": "推定請求トランザクション数",
  "Transactions needed": "必要なトランザクション数",
  "Total claimable": "請求可能な合計",
  "Total claims": "請求件数",
  "Remaining claims": "残りの請求",
  "Claimed UTxOs": "請求済みUTxO",
  "Matching UTxOs": "一致するUTxO",
  "Matching funds": "一致した資金",
  Found: "検出済み",
  "Helper service": "ヘルパーサービス",
  Connected: "接続済み",
  "Funds you can claim": "請求できる資金",
  "Total ADA": "ADA合計",
  "Total tokens": "トークン合計",
  "Total recovered": "回収済み合計",
  Recovered: "回収済み",
  "Funds sent to safe wallet": "安全なウォレットへ送信された資金",
  "Still unclaimed": "未請求",
  "Pending (not claimed)": "未処理（未請求）",
  "Ready to claim": "請求準備完了",
  "Proofs needed": "必要な証明",
  Proofs: "証明",
  "Proofs ready": "証明作成完了",
  "Local helper": "ローカルヘルパー",
  "Local proof method": "ローカル証明方法",
  "Prove in browser": "ブラウザで証明",
  "Browser prover": "ブラウザ証明機能",
  "Destination bound to": "送信先の紐付け",
  "Safe wallet (destination)": "安全なウォレット（送信先）",
  "Receive address": "受取アドレス",
  "Recovery summary": "リカバリー概要",
  "Claim transactions": "請求トランザクション",
  "Claim status": "請求状態",
  "Safe wallet connected": "安全なウォレットを接続しました",
  "Connect wallet to preview": "ウォレットを接続して確認",
  "Recovery complete": "リカバリー完了",
  "Claim submitted": "請求を送信しました",
  "Next step": "次の手順",
  "Before you claim": "請求する前に",
  "What happens next": "次に行われること",
  "Why these match": "一致する理由",
  "Why this comes before proofs": "証明作成より先に行う理由",
  "Use a clean destination": "安全な送信先を使用",
  "Shared wallet key": "共有されているウォレットキー",
  "The key comes from your impacted wallet": "被害を受けたウォレット由来のキー",
  "Your wallet key is listed": "あなたのウォレットキーが記録されています",
  "Find matching wallet keys": "一致するウォレットキーを検索",
  "Scan locked funds": "ロックされた資金を検索",
  "Scanning locked funds": "ロックされた資金を検索中",
  "Show claimable funds": "請求可能な資金を表示",
  "Show words": "単語を表示",
  "Paste phrase": "フレーズを貼り付け",
  "Recovery phrase": "リカバリーフレーズ",
  "Recovery phrase length": "リカバリーフレーズの単語数",
  "Impacted wallet recovery phrase": "被害を受けたウォレットのリカバリーフレーズ",
  "Impacted wallet signature": "被害を受けたウォレットの署名",
  "Impacted wallet will not sign": "被害を受けたウォレットでは署名しません",
  "No signature needed from impacted wallet": "被害を受けたウォレットの署名は不要",
  "Funds will arrive here": "資金の送信先",
  "Funds will go to your safe wallet": "資金は安全なウォレットへ送られます",
  "Fees paid by": "手数料の支払元",
  "Fees paid by safe wallet": "安全なウォレットが手数料を支払います",
  "Enough ADA for fees": "手数料に必要なADAあり",
  "Estimated fee (paid by safe wallet)": "推定手数料（安全なウォレットが支払い）",
  "Shown in your wallet before you approve signing": "署名を承認する前にウォレットへ表示されます",
  "Paid from your safe wallet, not from recovered funds.": "回収資金ではなく、安全なウォレットから支払われます。",
  "Transaction fees for claiming are paid from your safe wallet.":
    "請求トランザクションの手数料は安全なウォレットから支払われます。",
  "Claims are authorized by ReclaimGlobal.": "請求はReclaimGlobalによって承認されます。",
  "Claims are authorized by ReclaimGlobal": "請求はReclaimGlobalによって承認されます",

  // Claim flow: service and wallet screens.
  "Verify this recovery service": "このリカバリーサービスを確認",
  "This page is pinned to a specific deployment of the ReclaimGlobal contracts on Cardano mainnet. If you were given a deployment ID or commit hash, compare it here before continuing.":
    "このページはCardanoメインネット上の特定のReclaimGlobalコントラクトへ固定されています。デプロイIDまたはコミットハッシュを案内されている場合は、続行する前にここで照合してください。",
  "Deployment unavailable": "デプロイを利用できません",
  "The pinned claim deployment could not be loaded. Wallet connection and claim submission stay disabled until the manifest is available.":
    "固定された請求デプロイを読み込めませんでした。マニフェストを取得できるまで、ウォレット接続と請求送信は無効です。",
  "Connect the wallet that held the accounts affected by the SecondFi incident.":
    "SecondFiの事案で影響を受けたアカウントが入っていたウォレットを接続してください。",
  "This step only reads public wallet addresses and wallet keys (a public fingerprint of a key in your wallet — it cannot be used to spend funds). You will not sign a transaction with the impacted wallet.":
    "この手順では公開ウォレットアドレスとウォレットキー（ウォレット内の鍵を表す公開フィンガープリントで、支払いには使用できません）のみを読み取ります。被害を受けたウォレットでトランザクションに署名することはありません。",
  "Choose a Cardano browser wallet": "Cardanoブラウザウォレットを選択",
  "Works with CIP-30 wallets such as Lace, Eternl, and Yoroi.":
    "Lace、Eternl、YoroiなどのCIP-30ウォレットに対応しています。",
  "No wallet found": "ウォレットが見つかりません",
  Recommended: "推奨",
  "The simplest and most secure way to connect.": "最も簡単で安全な接続方法です。",
  "A feature-rich wallet for Cardano.": "高機能なCardanoウォレットです。",
  "Lightweight and easy to use.": "軽量で使いやすいウォレットです。",
  "Detected browser wallet extension.": "検出されたブラウザウォレット拡張機能です。",
  "Available browser wallet extension.": "利用可能なブラウザウォレット拡張機能です。",
  "Install or unlock a Cardano browser wallet, then refresh this page.":
    "Cardanoブラウザウォレットをインストールするかロックを解除し、このページを更新してください。",
  "If you used SecondFi, import that wallet's recovery phrase into Lace or another Cardano browser wallet first, then connect it here.":
    "SecondFiを利用していた場合は、まずそのウォレットのリカバリーフレーズをLaceなどのCardanoブラウザウォレットへインポートしてから、ここで接続してください。",
  "We'll look for wallet keys from this wallet that have available funds.":
    "このウォレットから、請求可能な資金に一致するウォレットキーを探します。",
  "We'll scan the ReclaimBase contract for funds tied to those wallet keys.":
    "ReclaimBaseコントラクトから、それらのウォレットキーに紐づく資金を検索します。",
  "Wrong network": "ネットワークが違います",
  "This wallet is not on the configured network. Switch the network inside your wallet, or select a different wallet, then try again.":
    "このウォレットは設定されたネットワークに接続されていません。ウォレット内でネットワークを切り替えるか、別のウォレットを選んで再試行してください。",
  "Checking on-chain records against your wallet keys.": "オンチェーンの記録とウォレットキーを照合しています。",
  "No matching funds found": "一致する資金が見つかりません",
  "We didn't find any locked funds matching this wallet. Try another wallet that held the affected accounts, or refresh later — rescuers may still be locking funds.":
    "このウォレットに一致するロック済み資金は見つかりませんでした。影響を受けたアカウントが入っていた別のウォレットを試すか、救出者がまだ資金をロックしている可能性があるため後でもう一度確認してください。",
  "These funds were locked for you by rescuers and match wallet keys from your impacted wallet.":
    "これらは救出者があなたのためにロックした資金で、被害を受けたウォレットのキーと一致します。",
  "Each locked fund records the wallet key it belongs to.":
    "ロックされた各資金には、対応するウォレットキーが記録されています。",
  "The wallet key matches keys derived from your impacted wallet.":
    "ウォレットキーは、被害を受けたウォレットから導出されたキーと一致します。",
  "Use View to inspect every asset and quantity inside a UTxO.":
    "「表示」を使って、UTxO内の各資産と数量を確認してください。",
  "Learn more about the matching process": "照合方法について詳しく見る",
  "Search tx, output, or credential": "トランザクション、出力、認証情報を検索",
  "Search claims by tx, output, or credential": "トランザクション、出力、認証情報から請求を検索",
  "Filter claims by asset type": "資産タイプで請求を絞り込む",
  All: "すべて",
  Tokens: "トークン",
  "Claims pages": "請求ページ",
  "Tx id": "トランザクションID",
  "Output #": "出力番号",
  "Tx reference": "トランザクション参照",
  "Recovered value": "回収した価値",
  Status: "状態",
  Claim: "請求",
  Value: "価値",
  Proof: "証明",
  Batch: "バッチ",
  "Assets (tokens)": "資産（トークン）",
  "Asset summary": "資産概要",
  Total: "合計",
  "Connect a wallet you know is safe. Claimed funds will be sent to this wallet.":
    "安全であることを確認できるウォレットを接続してください。請求した資金はこのウォレットへ送られます。",
  "Do not connect the impacted wallet here. Choose a wallet whose recovery phrase and devices were not exposed during the SecondFi incident.":
    "ここでは被害を受けたウォレットを接続しないでください。SecondFiの事案でリカバリーフレーズや端末が漏えいしていないウォレットを選んでください。",
  "Use a different wallet than the impacted wallet.": "被害を受けたウォレットとは別のウォレットを使用してください。",
  "This address will be embedded in your claim proofs to ensure funds can only be sent here.":
    "資金がこの送信先だけに送られるよう、このアドレスが請求証明へ組み込まれます。",
  "Your safe wallet is connected and set as the destination.": "安全なウォレットを接続し、送信先として設定しました。",
  "This safe wallet shares a wallet key with the impacted wallet. Choose a different destination.":
    "この安全なウォレットは被害を受けたウォレットと同じウォレットキーを共有しています。別の送信先を選んでください。",
  "More ADA needed": "ADAが不足しています",
  "Ensure your safe wallet has enough ADA to cover transaction fees.":
    "安全なウォレットにトランザクション手数料を支払うための十分なADAがあることを確認してください。",
  "Your safe wallet has 2.45 ADA — at least 5 ADA is needed for fees, collateral, and min-ADA. Recovered funds will not be reduced for fees.":
    "安全なウォレットの残高は2.45 ADAです。手数料、担保、最小ADA要件のために少なくとも5 ADAが必要です。手数料によって回収資金が減ることはありません。",

  // Claim flow: proving, submission, and receipt.
  "Claim proofs are destination-bound, so we need the safe wallet address before proofs are created.":
    "請求証明は送信先に紐づくため、証明を作成する前に安全なウォレットのアドレスが必要です。",
  "Enter the recovery phrase (seed phrase) for the impacted wallet, not the safe wallet.":
    "安全なウォレットではなく、被害を受けたウォレットのリカバリーフレーズ（シードフレーズ）を入力してください。",
  "Your recovery phrase and private keys never leave your device.":
    "リカバリーフレーズと秘密鍵が端末の外へ送信されることはありません。",
  "These words are never saved. Leaving this step clears them.":
    "入力した単語は保存されません。この手順を離れると消去されます。",
  "Proof generation blocked": "証明を作成できません",
  "Proof generation stopped": "証明の作成を停止しました",
  "Browser proving is not enabled for this build yet. Choose Proof Helper Desktop to generate proofs now.":
    "このビルドではブラウザ証明をまだ利用できません。証明を作成するにはProof Helper Desktopを選択してください。",
  "Browser proving reported an error. Your recovery phrase was not uploaded. Proof Helper Desktop is still available. For your security your recovery phrase was cleared — re-enter it before retrying.":
    "ブラウザ証明でエラーが発生しました。リカバリーフレーズはアップロードされていません。Proof Helper Desktopは引き続き利用できます。安全のためフレーズを消去したので、再試行する前に入力し直してください。",
  "All destination-bound proofs have been created locally for your available claims.":
    "請求可能な資金に必要な送信先紐づけ済み証明を、すべて端末上で作成しました。",
  "Your proofs were created locally on this device.": "証明はこの端末上で作成されました。",
  "Your proofs are bound to the safe wallet address. They can only be used to send recovered funds there.":
    "証明は安全なウォレットのアドレスに紐づいています。回収資金をそのアドレスへ送る場合にのみ使用できます。",
  "Generate local proofs for the wallet keys in this batch.":
    "このバッチのウォレットキーに対する証明を端末上で作成します。",
  "Claiming happens in two stages: first build the transaction and review it, then sign and submit it with your safe wallet.":
    "請求は2段階で行います。まずトランザクションを作成して内容を確認し、次に安全なウォレットで署名して送信します。",
  "Review each batch before submitting": "送信前に各バッチを確認",
  "You'll review all details for each batch before submitting on-chain.":
    "オンチェーンへ送信する前に、各バッチの詳細をすべて確認します。",
  "Your recovered funds will be sent to your safe wallet.": "回収資金は安全なウォレットへ送られます。",
  "Claim transactions are signed by your safe wallet.": "請求トランザクションは安全なウォレットで署名します。",
  "Review and submit your first transaction.": "最初のトランザクションを確認して送信します。",
  "Need to rescan? Go back to Available claims.": "再検索する場合は「請求可能な資金」まで戻ってください。",
  "Safe-wallet signature rejected": "安全なウォレットの署名が拒否されました",
  "Signature declined in wallet. The transaction was not submitted. Review the batch and ask the safe wallet to sign again.":
    "ウォレットで署名が拒否されました。トランザクションは送信されていません。バッチを確認し、安全なウォレットでもう一度署名してください。",
  "Your latest claim transaction is submitted and waiting for confirmation.":
    "最新の請求トランザクションは送信済みで、確認を待っています。",
  "The selected batch is pending. Confirmed spends will be removed from remaining funds. Checks automatically every 20 seconds.":
    "選択したバッチは処理待ちです。確認済みの支払いは残りの資金から除外されます。20秒ごとに自動確認します。",
  "All available claims for the impacted wallet have been submitted.":
    "被害を受けたウォレットで請求可能な資金をすべて送信しました。",
  "Review the funds recovered to your safe wallet and the on-chain transactions that claimed them.":
    "安全なウォレットへ回収された資金と、請求に使用したオンチェーントランザクションを確認してください。",
  "Download or share a summary of your recovery and transactions.":
    "リカバリーとトランザクションの概要をダウンロードまたは共有できます。",
  "The funds are still locked and have not been claimed yet.": "資金はまだロックされており、請求されていません。",
  "Connect a safe wallet to create the next claim draft.":
    "次の請求ドラフトを作成するには、安全なウォレットを接続してください。",
  "No active draft": "有効なドラフトがありません",
  "No active claim draft": "有効な請求ドラフトがありません",
  "Create a real claim draft before reviewing batch rows.":
    "バッチの行を確認する前に、実際の請求ドラフトを作成してください。",
  "You'll see the total funds available to claim before continuing.":
    "続行する前に、請求可能な資金の合計を確認できます。",
  "Step 1 of 2 — nothing is signed yet": "2段階中の1段階目 — まだ署名は行いません",
  "Build transaction for review": "確認用トランザクションを作成",
  "No tokens": "トークンなし",
  "SecondFi is in maintenance mode.": "SecondFiはメンテナンス中です。",

  // Proof generation progress and dialogs.
  "Proof generation is running in this browser. Keep this tab open.":
    "このブラウザで証明を作成しています。タブを開いたままにしてください。",
  "Running in browser": "ブラウザで実行中",
  "Generating destination-bound proofs": "送信先に紐づく証明を作成中",
  "Proving in this browser": "このブラウザで証明中",
  "Keep this tab open - refreshing will restart proof generation.":
    "このタブを開いたままにしてください。更新すると証明作成が最初からやり直しになります。",
  "Cancel proof generation": "証明作成をキャンセル",
  "Local only": "端末内のみ",
  "Destination bound": "送信先に紐づけ済み",
  "No server upload": "サーバー送信なし",
  "Proof queue": "証明キュー",
  "During proof generation": "証明作成中の注意",
  "Keep this tab open": "このタブを開いたままにする",
  "Browser proving runs here; closing or refreshing the tab restarts it.":
    "証明はこのタブで作成されます。閉じたり更新したりすると最初からやり直しになります。",
  "Do not refresh this page": "このページを更新しないでください",
  "Refreshing may interrupt the proof generation process.": "更新すると証明作成が中断される場合があります。",
  "Recovery phrase stays local": "リカバリーフレーズは端末内に保持",
  "Your recovery phrase never leaves your device and is never shared.":
    "リカバリーフレーズが端末の外へ送信・共有されることはありません。",
  "You can cancel if needed": "必要に応じてキャンセルできます",
  "Cancel to stop proving and return to the previous step.": "キャンセルすると証明作成を停止し、前の手順へ戻ります。",
  "Proofs are destination-bound": "証明は送信先に紐づいています",
  "They can only be used to reclaim funds to your connected safe wallet.":
    "接続した安全なウォレットへ資金を回収する場合にのみ使用できます。",
  "Proof generation in progress": "証明を作成中",
  "Choose how to create proofs": "証明の作成方法を選択",
  "Proofs are created locally on this device before you claim funds.":
    "資金を請求する前に、この端末上で証明を作成します。",
  "Close proof method chooser": "証明方法の選択画面を閉じる",
  "Proof Helper Desktop": "Proof Helper Desktop",
  "Recommended for speed": "速度を重視する場合に推奨",
  "Install or open the desktop app. Best for large batches and older browsers.":
    "デスクトップアプリをインストールまたは起動します。大きなバッチや古いブラウザに適しています。",
  "Opens the installer chooser for Windows, macOS, or Linux if needed.":
    "必要に応じてWindows、macOS、Linux用のインストーラーを選択できます。",
  "Install available": "インストール可能",
  "Prove in this browser": "このブラウザで証明",
  "No download": "ダウンロード不要",
  "No app install required. About 2 minutes per proof on a fast machine; needs a supported browser.":
    "アプリのインストールは不要です。高速な端末で1証明あたり約2分かかり、対応ブラウザが必要です。",
  "Keep this tab open while proofs are generated.": "証明作成中はこのタブを開いたままにしてください。",
  "Browser proving readiness": "ブラウザ証明の準備状況",
  "This browser can generate proofs": "このブラウザで証明を作成できます",
  "Checking browser support...": "ブラウザ対応状況を確認中…",
  "This browser cannot generate proofs yet": "このブラウザではまだ証明を作成できません",
  "Cross-origin isolation, memory, and pinned proof assets all verified.":
    "クロスオリジン分離、メモリ、固定された証明アセットをすべて確認しました。",
  "Verifying WebAssembly, workers, isolation, and proof assets.":
    "WebAssembly、ワーカー、分離設定、証明アセットを確認しています。",
  "Browser proving is not enabled for this build yet.": "このビルドではブラウザ証明をまだ利用できません。",
  "Cross-origin isolated": "クロスオリジン分離済み",
  "~2 min per proof": "1証明あたり約2分",
  "Your recovery phrase stays local and is read only after you choose a method.":
    "リカバリーフレーズは端末内に保持され、方法を選択した後にのみ読み取られます。",
  "Continue to desktop app": "デスクトップアプリへ進む",
  "Checking support...": "対応状況を確認中…",
  "Choose your installer": "インストーラーを選択",
  "Select the operating system for this computer.": "この端末のOSを選択してください。",
  "Close installer chooser": "インストーラー選択画面を閉じる",
  "Downloads the Windows helper installer.": "Windows用ヘルパーのインストーラーをダウンロードします。",
  "Download installer": "インストーラーをダウンロード",
  "Downloads the universal macOS helper package (older preview build).":
    "macOSユニバーサル版ヘルパー（旧プレビュービルド）をダウンロードします。",
  "Download .zip": ".zipをダウンロード",
  "Downloads the portable x86-64 AppImage.": "ポータブルx86-64 AppImageをダウンロードします。",
  "Download AppImage": "AppImageをダウンロード",
  "Verify the Linux AppImage": "Linux AppImageを検証",
  "Compare the download against the published SHA-256 before running it.":
    "実行前に、ダウンロードしたファイルを公開済みSHA-256と照合してください。",
  "Download checksum": "チェックサムをダウンロード",
  "Verification and launch instructions": "検証と起動の手順",
  "Windows zip start command": "Windows zip版の起動コマンド",
  "After extracting the zip, open Command Prompt in that folder and run this command so Proof Helper pairs back to this claim page.":
    "zipを展開後、そのフォルダーでコマンドプロンプトを開き、次のコマンドを実行してProof Helperをこの請求ページとペアリングします。",
  "Copy command": "コマンドをコピー",
  "Proof Helper paired": "Proof Helperをペアリングしました",
  "Connecting Proof Helper…": "Proof Helperへ接続中…",
  "Your claim is paired in the tab you already had open. This tab will close itself — if it stays open, you can close it and continue there.":
    "すでに開いているタブで請求をペアリングしました。このタブは自動的に閉じます。閉じない場合は手動で閉じ、元のタブで続行してください。",
  "Handing the Proof Helper connection to your open claim tab. This only takes a moment.":
    "Proof Helperの接続を開いている請求タブへ引き渡しています。まもなく完了します。",

  // Asset review modal.
  "UTxO assets": "UTxOの資産",
  "Close asset modal": "資産画面を閉じる",
  Credential: "認証情報",
  "Unique assets": "資産の種類",
  "Review the asset list before continuing. Claiming this UTxO sends all listed value to your safe wallet.":
    "続行する前に資産一覧を確認してください。このUTxOを請求すると、一覧にあるすべての価値が安全なウォレットへ送られます。",
  "Search policy id or asset name": "ポリシーIDまたは資産名を検索",
  "Search assets by policy id or asset name": "ポリシーIDまたは資産名から資産を検索",
  "Copy tx reference": "トランザクション参照をコピー",
  "Policy id": "ポリシーID",
  "Asset name": "資産名",
  Quantity: "数量",
  "No native assets in this UTxO.": "このUTxOにネイティブ資産はありません。",
  "No assets match this search.": "検索に一致する資産はありません。",
  "Showing 0 assets": "資産は0件です",
  "All matching assets shown": "一致する資産をすべて表示しています",

  // Lock / donate flow.
  "Lock flow": "ロックフロー",
  "Funding wallet": "資金提供ウォレット",
  "Compromised credential": "侵害された認証情報",
  Assets: "資産",
  "Review transaction": "トランザクションを確認",
  "Review the transaction details below. The funds will be locked at the reclaim contract.":
    "以下のトランザクション内容を確認してください。資金はリクレイムコントラクトにロックされます。",
  Submit: "送信",
  "Checking deployment": "デプロイを確認中",
  "Checking the ReclaimBase deployment before wallet actions are enabled.":
    "ウォレット操作を有効にする前にReclaimBaseデプロイを確認しています。",
  "Loading deployment": "デプロイを読み込み中",
  Loading: "読み込み中",
  "Waiting for the deployment check to finish.": "デプロイ確認の完了を待っています。",
  "Deployment ready": "デプロイ準備完了",
  "Preprod deployment ready": "Preprodデプロイ準備完了",
  "Credential set": "認証情報を設定済み",
  "All requirements met": "すべての要件を満たしています",
  "Move funds to ReclaimBase": "資金をReclaimBaseへ移動",
  "Connect the funding wallet to continue.": "続行するには資金提供ウォレットを接続してください。",
  Wallet: "ウォレット",
  "Cardano wallet": "Cardanoウォレット",
  Connection: "接続",
  "Connect Wallet": "ウォレットを接続",
  "Address source": "アドレスの取得元",
  "Connect wallet to load CIP-30 addresses": "CIP-30アドレスを読み込むにはウォレットを接続",
  "Change address": "お釣りアドレス",
  "No manual address entry. The change address is read from CIP-30 internally for Lucid change, and the backend checks connected wallet addresses for funded inputs.":
    "アドレスの手入力はありません。お釣り用アドレスはLucidがCIP-30から内部的に読み取り、バックエンドは接続済みウォレットのアドレスから資金入力を確認します。",
  "Refresh Assets": "資産を更新",
  "Payment key credential": "支払いキー認証情報",
  REQUIRED: "必須",
  Required: "必須",
  "Paste the 56-character payment key hash": "56文字の支払いキーハッシュを貼り付け",
  "Enter the compromised credential to continue.": "続行するには侵害された認証情報を入力してください。",
  "Funds locked for recovery using proof of ownership for this payment key credential.":
    "この支払いキー認証情報の所有権証明を使って、リカバリー用に資金をロックします。",
  "Credential format": "認証情報の形式",
  "Use a 28-byte hex payment credential.": "28バイトの16進数支払い認証情報を使用してください。",
  "Assets to lock": "ロックする資産",
  "ADA amount": "ADA数量",
  "Wallet inventory": "ウォレット資産一覧",
  "Native token assets": "ネイティブトークン資産",
  "No native tokens selected. Use Token to choose assets from the connected wallet.":
    "ネイティブトークンが選択されていません。「トークン」から接続済みウォレットの資産を選択してください。",
  Asset: "資産",
  Token: "トークン",
  "Build Transaction": "トランザクションを作成",
  "Ready to build": "作成準備完了",
  "Building unsigned tx": "未署名トランザクションを作成中",
  "The backend is constructing a transaction pinned to the deployment manifest.":
    "バックエンドがデプロイマニフェストに固定されたトランザクションを作成しています。",
  "Unsigned transaction built": "未署名トランザクションを作成しました",
  "Ready for wallet signature": "ウォレット署名の準備完了",
  "Backend-built Cardano transaction with inline datum.":
    "バックエンドで作成したインラインデータム付きCardanoトランザクションです。",
  "Assets in transaction": "トランザクション内の資産",
  "Sign and Submit": "署名して送信",
  "Ready to sign": "署名準備完了",
  "Awaiting wallet": "ウォレットを待機中",
  "These assets will be locked at the reclaim contract.": "これらの資産はリクレイムコントラクトへロックされます。",
  "You will be prompted by your wallet to sign the transaction.":
    "ウォレットでトランザクションへの署名を求められます。",
  "Action failed": "操作に失敗しました",
  "Missing configuration": "設定が不足しています",
  "Reclaim deployment unavailable": "リクレイムデプロイを利用できません",
  "Reclaim deployment is unavailable.": "リクレイムデプロイを利用できません。",
  "Reclaim deployment configuration is missing, so wallet actions are disabled.":
    "リクレイムデプロイの設定が不足しているため、ウォレット操作は無効です。",
  "Transaction submitted": "トランザクションを送信しました",
  "The transaction has been submitted to lock compromised-credential funds at ReclaimBase.":
    "侵害された認証情報の資金をReclaimBaseへロックするトランザクションを送信しました。",
  "Funds locked": "資金をロックしました",
  "Receipt available": "受領記録を確認できます",
  "Locked value": "ロックした価値",
  Destination: "送信先",
  "Review / receipt": "確認・受領記録",
  "Credential datum": "認証情報データム",
  "Datum CBOR": "データムCBOR",
  "Tx hash": "トランザクションハッシュ",
  "Assets locked": "ロックした資産",
  "Lock another batch": "別のバッチをロック",
  "Go to Claim funds": "資金の請求へ進む",
  "No assets selected.": "資産が選択されていません。",
  "Add token from wallet": "ウォレットからトークンを追加",
  "Choose a native asset held by the connected funding wallet.":
    "接続した資金提供ウォレットが保有するネイティブ資産を選択してください。",
  "Close token selector": "トークン選択画面を閉じる",
  "Search policy ID or token name": "ポリシーIDまたはトークン名を検索",
  "Wallet inventory not loaded": "ウォレット資産一覧が未取得です",
  "Not loaded": "未取得",
  "Refresh the connected CIP-30 wallet inventory before choosing a native asset.":
    "ネイティブ資産を選ぶ前に、接続済みCIP-30ウォレットの資産一覧を更新してください。",
  "Refresh wallet inventory": "ウォレット資産一覧を更新",
  "No matching native assets": "一致するネイティブ資産がありません",
  "No wallet asset matches that search.": "検索に一致するウォレット資産はありません。",
  "This connected wallet inventory has no native tokens.":
    "接続したウォレットの資産一覧にネイティブトークンはありません。",
  "Wallet native assets": "ウォレットのネイティブ資産",
  Available: "利用可能",
  Unit: "資産単位",
  Select: "選択",
  "Selected native asset": "選択中のネイティブ資産",
  "Selected asset": "選択中の資産",
  "Amount to lock": "ロックする数量",
  "Add token": "トークンを追加",
  "Select a wallet asset": "ウォレット資産を選択",
  "Choose a token from the inventory list to fill its exact asset unit.":
    "資産一覧からトークンを選ぶと、正確な資産単位が入力されます。",
  "Enter unit manually": "資産単位を手入力",
  "Mock build rejected for screenshot coverage.": "スクリーンショット確認用の模擬作成が失敗しました。",
};

export function translateJapanese(value: string): string {
  const exact = exactMessages[value];
  if (exact) {
    return exact;
  }

  const deploymentPinnedMatch =
    /^This page is pinned to a specific deployment of the ReclaimGlobal contracts on (.+)\. If you were given a deployment ID or commit hash, compare it here before continuing\.$/u.exec(
      value,
    );
  if (deploymentPinnedMatch) {
    const network =
      deploymentPinnedMatch[1] === "the configured network" ? "設定済みネットワーク" : deploymentPinnedMatch[1];
    return `このページは、${network}上にデプロイされた特定のReclaimGlobalコントラクトに固定されています。デプロイIDまたはコミットハッシュを受け取っている場合は、続行前にここで照合してください。`;
  }

  const copyCredentialMatch = /^Copy credential (\d+)$/u.exec(value);
  if (copyCredentialMatch) {
    return `認証情報 ${copyCredentialMatch[1]} をコピー`;
  }
  const copyTxReferenceMatch = /^Copy tx reference (\d+)$/u.exec(value);
  if (copyTxReferenceMatch) {
    return `トランザクション参照 ${copyTxReferenceMatch[1]} をコピー`;
  }
  const copyMatch = /^Copy (.+)$/u.exec(value);
  if (copyMatch) {
    return `${translateJapanese(copyMatch[1])}をコピー`;
  }
  const recoveryWordMatch = /^Recovery word (\d+)$/u.exec(value);
  if (recoveryWordMatch) {
    return `リカバリーワード ${recoveryWordMatch[1]}`;
  }
  const wordPlaceholderMatch = /^(\d+)\s+word (\d+)$/u.exec(value);
  if (wordPlaceholderMatch) {
    return `${wordPlaceholderMatch[1]}. 単語 ${wordPlaceholderMatch[2]}`;
  }
  const removeTokenMatch = /^Remove native token (\d+)$/u.exec(value);
  if (removeTokenMatch) {
    return `ネイティブトークン ${removeTokenMatch[1]} を削除`;
  }
  const generatedProofsMatch = /^(\d+) of (\d+)$/u.exec(value);
  if (generatedProofsMatch) {
    return `${generatedProofsMatch[1]}/${generatedProofsMatch[2]}`;
  }
  const countMatch = /^(\d+) (UTxOs?|tokens?|assets?|words?|claims?)$/u.exec(value);
  if (countMatch) {
    const [, count, unit] = countMatch;
    const translatedUnit = unit.startsWith("UTxO")
      ? "件のUTxO"
      : unit.startsWith("token")
        ? "トークン"
        : unit.startsWith("asset")
          ? "件の資産"
          : unit.startsWith("word")
            ? "単語"
            : "件の請求";
    return `${count}${translatedUnit}`;
  }
  const addressesLoadedMatch = /^(\d+) CIP-30 (?:wallet )?addresses loaded$/u.exec(value);
  if (addressesLoadedMatch) {
    return `${addressesLoadedMatch[1]}件のCIP-30ウォレットアドレスを読み込み済み`;
  }
  const acrossKeysMatch = /^Across (\d+) wallet keys?$/u.exec(value);
  if (acrossKeysMatch) {
    return `${acrossKeysMatch[1]}件のウォレットキーに一致`;
  }
  const showingUtxosMatch = /^Showing (\d+)-(\d+) of (\d+) UTxOs$/u.exec(value);
  if (showingUtxosMatch) {
    return `${showingUtxosMatch[3]}件のUTxOのうち${showingUtxosMatch[1]}〜${showingUtxosMatch[2]}件を表示`;
  }
  const moreMatch = /^\+ (\d+) more$/u.exec(value);
  if (moreMatch) {
    return `ほか${moreMatch[1]}件`;
  }
  const moreClaimsMatch = /^…and (\d+) more claims$/u.exec(value);
  if (moreClaimsMatch) {
    return `…ほか${moreClaimsMatch[1]}件の請求`;
  }
  const totalClaimsMatch = /^(\d+) total claims - proving in this browser$/u.exec(value);
  if (totalClaimsMatch) {
    return `全${totalClaimsMatch[1]}件の請求をこのブラウザで証明中`;
  }
  const generatingProofsMatch = /^Generating (\d+) destination-bound proofs$/u.exec(value);
  if (generatingProofsMatch) {
    return `${generatingProofsMatch[1]}件の送信先に紐づく証明を作成中`;
  }
  const batchMatch = /^Batch (\d+) of (\d+)$/u.exec(value);
  if (batchMatch) {
    return `バッチ ${batchMatch[1]}/${batchMatch[2]}`;
  }
  const utxosReadyMatch = /^(\d+) UTxOs ready$/u.exec(value);
  if (utxosReadyMatch) {
    return `${utxosReadyMatch[1]}件のUTxOを請求可能`;
  }
  const utxosPerBatchMatch = /^(\d+) UTxOs per batch$/u.exec(value);
  if (utxosPerBatchMatch) {
    return `1バッチあたり${utxosPerBatchMatch[1]}件のUTxO`;
  }
  const tokenUtxoMatch = /^(\d+) tokens? - (\d+) UTxOs$/u.exec(value);
  if (tokenUtxoMatch) {
    return `${tokenUtxoMatch[1]}トークン・${tokenUtxoMatch[2]}件のUTxO`;
  }
  const assetsUtxosMatch = /^(\d+) assets?, (\d+) UTxOs$/u.exec(value);
  if (assetsUtxosMatch) {
    return `${assetsUtxosMatch[1]}件の資産・${assetsUtxosMatch[2]}件のUTxO`;
  }
  const utxosAssetsMatch = /^(\d+) UTxOs, (\d+) assets?$/u.exec(value);
  if (utxosAssetsMatch) {
    return `${utxosAssetsMatch[1]}件のUTxO・${utxosAssetsMatch[2]}件の資産`;
  }
  const submittedTransactionMatch = /^The transaction has been successfully submitted\. Transaction hash: (.+)$/u.exec(
    value,
  );
  if (submittedTransactionMatch) {
    return `トランザクションを送信しました。トランザクションハッシュ: ${submittedTransactionMatch[1]}`;
  }
  const adaTokensMatch = /^(\d+(?:\.\d+)?) ADA ([+-]) (\d+) tokens?$/u.exec(value);
  if (adaTokensMatch) {
    return `${adaTokensMatch[1]} ADA ${adaTokensMatch[2]} ${adaTokensMatch[3]}トークン`;
  }
  const adaCommaTokensMatch = /^(\d+(?:\.\d+)?) ADA, (\d+) tokens?$/u.exec(value);
  if (adaCommaTokensMatch) {
    return `${adaCommaTokensMatch[1]} ADA・${adaCommaTokensMatch[2]}トークン`;
  }
  const tokensConfirmedMatch = /^(\d+) tokens? confirmed$/u.exec(value);
  if (tokensConfirmedMatch) {
    return `${tokensConfirmedMatch[1]}トークン確認済み`;
  }
  return value;
}
