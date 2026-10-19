/**
 * Тесты для Simple Vault на devnet
 *
 * Сценарий:
 *   1. Admin создаёт vault (initialize_vault)
 *   2. Пользователи A и B создают свои карточки (create_user_card)
 *   3. Повторное создание карточки A падает
 *   4. Владелец закрывает карточку и получает ренту обратно
 *   5. На паузе новая карточка не создаётся, после снятия паузы — создаётся
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

// Переводим SOL от admin → pubkey (обходит rate limit devnet airdrop)
async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

describe("simple_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  before(async () => {
    await fundFromAdmin(provider, admin, userA.publicKey);
    await fundFromAdmin(provider, admin, userB.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("initialize_vault: vault создан", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    assert.equal(vault.paused, false);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB]) {
      const userCard = cardPda(user.publicKey);
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
      const now = Math.floor(Date.now() / 1000);
      assert.closeTo(card.createdAt.toNumber(), now, 120);
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  it("close_user_card: карточка закрыта, рента вернулась владельцу", async () => {
    const userCard = cardPda(userB.publicKey);
    const info = await provider.connection.getAccountInfo(userCard);
    assert.isNotNull(info);
    const before = await provider.connection.getBalance(userB.publicKey);

    await program.methods
      .closeUserCard()
      .accounts({
        vaultState: vaultStatePDA,
        userCard,
        user: userB.publicKey,
      } as any)
      .signers([userB])
      .rpc();

    const after = await provider.connection.getBalance(userB.publicKey);
    assert.isNull(await provider.connection.getAccountInfo(userCard));
    // Рента возвращается на user, из баланса вычитается только комиссия транзакции.
    assert.isAtLeast(after, before + info!.lamports - 20_000);
  });

  it("set_paused: чужой кошелёк не может поставить vault на паузу", async () => {
    let failed = false;
    try {
      await program.methods
        .setPaused(true)
        .accounts({ vaultState: vaultStatePDA, admin: userA.publicKey } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "паузу может включить только admin");
  });

  it("create_user_card: на паузе карточка не создаётся", async () => {
    await program.methods
      .setPaused(true)
      .accounts({ vaultState: vaultStatePDA, admin: admin.publicKey } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.paused, true);

    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userB.publicKey),
          user: userB.publicKey,
        } as any)
        .signers([userB])
        .rpc();
    } catch (err: any) {
      failed = true;
      const text = `${err} ${err?.error?.errorCode?.code ?? ""} ${err?.error?.errorMessage ?? ""}`;
      assert.include(text, "VaultPaused");
    }
    assert.isTrue(failed, "на паузе создание карточки должно быть отклонено");
  });

  it("create_user_card: после снятия паузы карточка снова создаётся", async () => {
    await program.methods
      .setPaused(false)
      .accounts({ vaultState: vaultStatePDA, admin: admin.publicKey } as any)
      .rpc();

    const userCard = cardPda(userB.publicKey);
    await program.methods
      .createUserCard()
      .accounts({ vaultState: vaultStatePDA, userCard, user: userB.publicKey } as any)
      .signers([userB])
      .rpc();

    const card = await program.account.userCard.fetch(userCard);
    assert.equal(card.owner.toBase58(), userB.publicKey.toBase58());
    const now = Math.floor(Date.now() / 1000);
    assert.closeTo(card.createdAt.toNumber(), now, 120);
  });
});
