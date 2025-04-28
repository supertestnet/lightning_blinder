# LSP Blinder
Trick an LSP into thinking *one* wallet is the sender or recipient when it's *really* some other wallet

# Protocol setup
The protocol requires three pieces of software: LSP Blinder Send (LBS), LSP Blinder Receive (LBR), and LSP Blinder Coordinate (LBC).

LBS needs to be software that can do three things: (1) send LN payments (2) parse an LN invoice with a custom field, to be described shortly (3) communicate with LBR in a manner to be described shortly.

LBC needs to be software that can do three things: (1) send LN payments (2) receive LN payments (3) communicate with LBR in a manner to be described shortly. Without taking custody of user funds, it will serve as a decoy recipient: the LSP will *think* it is sending money to LBC but it's *really* sending money to LBR.

LBR needs to be software that can do five things: (1) create hodl invoices (2) detect when a hodl invoice's state changes from "open" (not paid yet) to "pending" (i.e. the invoice has an htlc in a pending state, but it hasn't been settled or resolved yet) (3) receive LN payments (4) communicate with LBC in a manner to be described shortly (5) communicate with LBS in a manner to be described shortly.

# Protocol flow
The protocol begins when LBR decides it wants to receive money. First it reaches out to LBC and tells it what amount it wants to receive. LBC then creates a standard lightning invoice for that amount (or possibly a bit more, e.g. the LBC might charge a fee) and gives it to LBR -- we will call this invoice the "original invoice." Next, LBR creates a "wrapped invoice" -- an invoice for the same amount as the original invoice (or a bit less, if LBC added a fee), locked to the same preimage as the original invoice, but with a smaller timelock value. LBR gives this "wrapped invoice" to LBC, who pays it, knowing LBR cannot settle the invoice because LBR does not know the preimage -- only LBC knows that at this time.

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

# How to hide the sender too
The protocol as described above fools an LSP into thinking one of their users is sending money to person A when they are really sending money to person B. But there is another way to use LSP Blinder: have person A -- who I have decided to call Charlie, momentarily -- run the LBC software.

Now suppose a user of LSP Blinder -- whom I shall call Dave -- picks Charlie as their LBC, and suppose a man named Bob wants to pay Dave through Charlie -- so the payment is going Bob -> Charlie -> Dave. When Dave receives the payment from Bob (through Charlie), Bob's LSP thinks Charlie is the recipient when the real recipient is Dave. But that's not all: Charlie is using an LSP too, and Charlie's LSP will think *Charlie* is the sender when he's actually forwarding a payment from Bob to Dave. So not only do you hide Dave (the real recipient), you also hide Bob (the real sender).

Thus LSP Blinder ruins the heuristics used by LSPs to identify recipients *and senders.* If LSP Blinder sees just a little adoption, LSP heuristics won't work anymore and they will be unable to identify senders and recipients. Even if the payment looks like it's going directly from one of their users to another, they won't know if those people are the "real" senders and recipients or just LBCs forwarding payments for other people. And privacy on the lightning network will be significantly enhanced.

# Read this if you think this sounds like LN Proxy
LN Proxy (https://github.com/lnproxy) is similar software that *also* hides the "real" recipient from people like LSPs. But only a few people run LN Proxy and I think that's largely because it takes special software -- you have to install LND (because other LN implementations don't natively support hodl invoices), run LN Proxy on top of it, and configure a web server to expose it so folks can use it. With LSP Blinder, I want to eliminate those requirements.

I want anyone to be able to run all the pieces of software easily -- you just click a button to run the server directly in your browser, connect the server to almost any lightning wallet (hopefully via NWC), and you're done. Leave it running and check in later to see if you made any money. I plan to lower the barrier to entry compared to LN Proxy by (1) not requiring coordinators to install a wallet that supports hodl invoices (instead, they can use almost ANY lightning wallet) (2) designing the server so you can just run it in your browser.

If coordinators simply make their feerates public (probably via nostr), users can pick one or more coordinators based on their feerates, and all the "important" logic can be handled on the client side, by the sender and the recipient. I can build a prototype wallet to demonstrate that the protocol works, and then other wallets can implement support for this protocol if there's demand. Hopefully, privacy on the lightning network will improve as a result.
