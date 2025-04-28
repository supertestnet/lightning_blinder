# LSP blinder
Trick an LSP into thinking *one* wallet is the sender or recipient when it's *really* some other wallet

# Protocol setup
The protocol requires three pieces of software: LSP Blinder Send (LBS), LSP Blinder Receive (LBR), and LSP Blinder Coordinate (LBC).

LBS needs to be software that can do three things: (1) send LN payments (2) parse an LN invoice with a custom field, to be described shortly (3) communicate with LBR in a manner to be described shortly.

LBC needs to be software that can do three things: (1) send LN payments (2) receive LN payments (3) communicate with LBR in a manner to be described shortly. Without taking custody of user funds, it will serve as a decoy recipient: the LSP will *think* it is sending money to LBC but it's *really* sending money to LBR.

LBR needs to be software that can do five things: (1) create hodl invoices (2) detect when a hodl invoice's state changes from "open" (not paid yet) to "pending" (i.e. the invoice has an htlc in a pending state, but it hasn't been settled or resolved yet) (3) receive LN payments (4) communicate with LBC in a manner to be described shortly (5) communicate with LBS in a manner to be described shortly.

# Protocol flow
The protocol begins when LBR decides it wants to receive money. First it reaches out to LBC and tells it what amount it wants to receive. LBC then creates a standard lightning invoice for that amount and gives it to LBR -- we will call this invoice the "original invoice." Next, LBR creates a "wrapped invoice" -- an invoice for the same amount, locked to the same preimage, and with a smaller timelock value. LBR gives this "wrapped invoice" to LBC, who pays it, knowing LBR cannot settle the invoice because LBR does not know the preimage -- only LBC knows that at this time.

Once LBR detects that the invoice's state changed from "open" to "pending," it should take the "original invoice" and show it to LBS, and append to the invoice some data about a communication channel by which LBS can communicate with LBR. LBS now pays the original invoice. Assuming LBS uses an LSP that constructs the payment route, the LSP will *think* it is paying LBC, because that is the node whose pubkey appears in the invoice.

But here's where things get fun: if the payment fails, no payment happened, so there is nothing useful for the LSP to learn; you can't trace a payment that never happens. And if the payment succeeds, then due to the way the lightning network works, LBS necessarily receives the preimage that not only resolves the *original* invoice -- it is also capable of resolving the *wrapped* invoice, because that is locked to the *same preimage.*

So now LBS removes *sends* that preimage to LBR via the communication channel provided by LBR when they showed LBS the original invoice (the one they appended to it as described above). Once LBR receives the preimage from LBS, it uses that preimage to *settle the wrapped invoice* -- thus completing the route. LBC routed a payment from LBS to LBR, without taking custody of any money, and without its wallet needing any code for routing.

# Why this is cool
This protocol enables a bunch of cool features:

- The LBC software is very simple and can use any lightning backend that can send LN payments and receive LN payments. That means anyone can run LBC on top of basically any lightning wallet and charge fees for the use of this blinding software.
- People who want better privacy than they can get from a regular LSP can use one or more LBCs as a kind of "LN routing vpn," enhancing their privacy.
- LSP Blinder ruins the heuristics LSPs use to identify recipients. The LSP will think they are forwarding a payment to person A (the LBC) but the money is really going to person B (the LBR). Thus they can no longer reliably trace a payment to the correct recipient, as long as the recipient is using LSP Blinder.
- LSPs cannot tell if you are using LSP Blinder. The only thing indicating that is the information appended to the original invoice, but LSPs do not see that information, only LBS does, and he has no reason to share it with the LSP.
- Wallets thus get a privacy advantage without even using the software. Because of its undetectability, if even a small percentage of people use LSP Blinder, LSPs can no longer be sure their heuristics work for *anyone,* because they cannot detect who is using it and who isn't.

# Expansion option: hide the sender too
The protocol as described above fools an LSP into thinking LBS is sending money to LBC when they are really sending money to LBR. But there is another way to use LSP Blinder: have LBS -- who I have decided to call Charlie, monetarily -- run the LBC software.

Now suppose an LBR -- whom I shall call Dave -- uses Charlie as their LBC, and suppose a man named Bob wants to pay Dave through Charlie -- so the payment is going Bob -> Charlie -> Dave. When Dave receives the payment from Bob (through Charlie), Bob's LSP thinks Charlie is the recipient when the real recipient is Dave. But that's not all: Charlie is using an LSP too, and Charlie's LSP will think *Charlie* is the sender when he's actually forwarding a payment from Bob to Dave. So not only do you hide Dave (the real recipient), you also hide Bob (the real sender).

Thus LSP Blinder ruins the heuristics used by LSPs to identify recipients *and senders.* If LSP Blinder sees just a little adoption, LSP heuristics will be ruined and they will no longer know who is sending to whom. And privacy on the lightning network will be significantly enhanced.
