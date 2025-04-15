const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const formulaCommon = require('ocore/formula/common.js');
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

describe('Deposits with force close that is challenged', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../bonded-stablecoin-factory.oscript') })
			.with.agent({ daf2: path.join(__dirname, '../define-asset2-forwarder.oscript') })
			.with.agent({ governance: path.join(__dirname, '../governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../deposits.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.wallet({ charlie: 1000e9 })
			.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.charlie = this.network.wallet.charlie
		this.charlieAddress = await this.charlie.getAddress()

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
	})

	it('Post data feed', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					RECH: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.RECH).to.be.equal(20)
		await this.network.witnessUntilStable(unit)

		this.price = price
		this.target_p2 = 1/price
	})
	
	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		const ts = Math.floor(Date.now() / 1000)
		this.fee_multiplier = 5
		this.interest_rate = 0.1
		this.reporter_share = 0.3
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.bsf,
			amount: 15000,
			data: {
				reserve_asset: 'base',
				reserve_asset_decimals: 9,
				decimals1: 9,
				decimals2: 2,
				m: 2,
				n: 0.5,
				interest_rate: this.interest_rate,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'RECH',
				deposits: {
					reporter_share: this.reporter_share,
				},
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.bsf)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(6)
		for (let name in vars) {
			if (name.startsWith('curve_')) {
				this.curve_aa = name.substr(6)
				expect(vars[name]).to.be.equal("s1^2 s2^0.5")
			}
		}
		this.asset1 = vars['asset_' + this.curve_aa + '_1'];
		this.asset2 = vars['asset_' + this.curve_aa + '_2'];
		this.asset_stable = vars['asset_' + this.curve_aa + '_stable'];
		this.deposit_aa = vars['deposit_aa_' + this.curve_aa];
		this.governance_aa = vars['governance_aa_' + this.curve_aa];

		const { vars: curve_vars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log('curve vars', curve_vars, this.curve_aa)
		expect(curve_vars['asset1']).to.be.equal(this.asset1)
		expect(curve_vars['asset2']).to.be.equal(this.asset2)
		expect(curve_vars['governance_aa']).to.be.equal(this.governance_aa)
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.equal(1)
		expect(curve_vars['interest_rate']).to.be.equal(0.1)
		expect(parseInt(curve_vars['rate_update_ts'])).to.be.gte(ts)

		this.getReserve = (s1, s2) => Math.ceil(1e9*(s1/1e9)**2 * (s2/1e2)**0.5)
		this.getP2 = (s1, s2) => (s1/1e9)**2 * 0.5 / (s2/1e2)**0.5
		this.getFee = (avg_reserve, old_distance, new_distance) => Math.ceil(avg_reserve * (new_distance**2 - old_distance**2) * this.fee_multiplier);

		this.buy = (tokens1, tokens2) => {
			const new_supply1 = this.supply1 + tokens1
			const new_supply2 = this.supply2 + tokens2
			const new_reserve = this.getReserve(new_supply1, new_supply2)
			const amount = new_reserve - this.reserve
			const abs_reserve_delta = Math.abs(amount)
			const avg_reserve = (this.reserve + new_reserve)/2
			const p2 = this.getP2(new_supply1, new_supply2)
	
			const old_distance = this.reserve ? Math.abs(this.p2 - this.target_p2) / this.target_p2 : 0
			const new_distance = Math.abs(p2 - this.target_p2) / this.target_p2
			let fee = this.getFee(avg_reserve, old_distance, new_distance);
			if (fee > 0) {
				const reverse_reward = Math.floor((1 - old_distance / new_distance) * this.fast_capacity); // rough approximation
			}

			const fee_percent = round(fee / abs_reserve_delta * 100, 4)
			const reward = old_distance ? Math.floor((1 - new_distance / old_distance) * this.fast_capacity) : 0;
			const reward_percent = round(reward / abs_reserve_delta * 100, 4)

			console.log('p2 =', p2, 'target p2 =', this.target_p2, 'amount =', amount, 'fee =', fee, 'reward =', reward, 'old distance =', old_distance, 'new distance =', new_distance, 'fast capacity =', this.fast_capacity)
	
			this.p2 = p2
			this.distance = new_distance
			if (fee > 0) {
				this.slow_capacity += Math.floor(fee / 2)
				this.fast_capacity += fee - Math.floor(fee / 2)
			}
			else if (reward > 0)
				this.fast_capacity -= reward
			
			if (fee > 0 && reward > 0)
				throw Error("both fee and reward are positive");
			if (fee < 0 && reward < 0)
				throw Error("both fee and reward are negative");
	
			this.supply1 += tokens1
			this.supply2 += tokens2
			this.reserve += amount
	
			return { amount, fee, fee_percent, reward, reward_percent }
		}

		this.supply1 = 0
		this.supply2 = 0
		this.reserve = 0
		this.slow_capacity = 0
		this.fast_capacity = 0
		this.distance = 0
	})


	it('Alice buys tokens', async () => {
		const tokens1 = 1e9
		const tokens2 = 100e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + 1000,
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		console.log('response vars', response.response.responseVars)
		expect(response.response.responseVars['fee%']).to.be.equal(fee ? fee_percent+'%' : undefined)

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(round(vars['p2'], 13)).to.be.equal(round(this.p2, 13))
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity || undefined)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity || undefined)
		expect(vars['lost_peg_ts']).to.be.undefined

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset1,
				amount: tokens1,
			},
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
		])

	})

	it('Half a year later, Alice exchanges tokens2 for stable tokens', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		const tokens2 = Math.floor(this.supply2 / 2)
		const stable_tokens = Math.floor(tokens2 * Math.sqrt(1 + this.interest_rate))
		this.supply = stable_tokens

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset2,
			base_outputs: [{ address: this.deposit_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.deposit_aa, amount: tokens2 }],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		const id = unit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.id).to.be.equal(unit)

		const { vars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['supply']).to.be.equal(this.supply)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset_stable,
			amount: stable_tokens,
		}])

		expect(vars['deposit_' + id]).to.deep.equalInAnyOrder({
			amount: tokens2,
			stable_amount: stable_tokens,
			owner: this.aliceAddress,
			ts: unitObj.timestamp,
		})

		this.id = id
		this.deposit_stable_tokens = stable_tokens
		this.deposit_tokens2 = tokens2
		this.ts = unitObj.timestamp
	})

	it('Bob buys tokens and immediately sends token2 to open a deposit', async () => {
		this.target_p2 = 1/this.price * (1 + this.interest_rate)**0.5
		const tokens1 = 1.0241e9
		const tokens2 = 100e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const stable_tokens = Math.floor(tokens2 * Math.sqrt(1 + this.interest_rate))
		this.supply += stable_tokens

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + fee + 1000 + 2000, // 1000 network fee + 2000 aa2aa fee
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
				tokens2_to: this.deposit_aa,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log('response', response.response.responseVars)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['fee%']).to.be.equal(fee_percent+'%')

		const { response: response2 } = await this.network.getAaResponseToUnit(response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(round(vars['p2'], 13)).to.be.equal(round(this.p2, 13))
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)

		const id = response.response_unit
		const { vars: dvars } = await this.bob.readAAStateVars(this.deposit_aa)
		console.log(dvars)
		expect(dvars['supply']).to.be.equal(this.supply)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response2.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.bobAddress,
			asset: this.asset_stable,
			amount: stable_tokens,
		}])
		expect(vars['lost_peg_ts']).to.be.equal(unitObj.timestamp)
		expect(dvars['deposit_' + id]).to.deep.equalInAnyOrder({
			amount: tokens2,
			stable_amount: stable_tokens,
			owner: this.bobAddress,
			ts: unitObj.timestamp,
		})

		this.bob_id = id
		this.bob_ts = unitObj.timestamp
		this.bob_deposit_tokens2 = tokens2
		this.bob_deposit_stable_tokens = stable_tokens
	})

	it('Alice adds protection to her deposit', async () => {
		const amount = 2e9

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.deposit_aa,
			amount: amount,
			data: {
				add_protection: 1,
				id: this.id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log('response vars', response.response.responseVars)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['supply']).to.be.equal(this.supply)

		expect(vars['deposit_' + this.id]).to.deep.equalInAnyOrder({
			amount: this.deposit_tokens2,
			stable_amount: this.deposit_stable_tokens,
			protection: amount,
			owner: this.aliceAddress,
			ts: this.ts,
		})

		this.protection = amount
	})

	it('Bob adds protection to his deposit', async () => {
		const amount = 3e9 // note that Bob's deposit is 2 times larger than Alice's and this protection is equivalent to 1.5e9 protection on Alice's deposit

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.deposit_aa,
			amount: amount,
			data: {
				add_protection: 1,
				id: this.bob_id,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log('response vars', response.response.responseVars)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['supply']).to.be.equal(this.supply)

		expect(vars['deposit_' + this.bob_id]).to.deep.equalInAnyOrder({
			amount: this.bob_deposit_tokens2,
			stable_amount: this.bob_deposit_stable_tokens,
			protection: amount,
			owner: this.bobAddress,
			ts: this.bob_ts,
		})
		this.bob_protection_ratio = amount / this.bob_deposit_tokens2
	})


	it("1 year later, Bob requests a force-close of the Alice's deposit", async () => {
		const { time_error } = await this.network.timetravel({shift: '360d'})
		expect(time_error).to.be.undefined

		const overpayment = 100
		const new_stable_amount = Math.floor(this.deposit_tokens2 * (1+this.interest_rate)**1.5)
		this.interest = new_stable_amount - this.deposit_stable_tokens
		this.protection_ratio = this.protection / this.deposit_tokens2

		const { unit, error } = await this.bob.sendMulti({
			asset: this.asset_stable,
			base_outputs: [{ address: this.deposit_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.deposit_aa, amount: new_stable_amount + overpayment }],
			messages: [{
				app: 'data',
				payload: {
					id: this.id,
				}
			}],
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit
		const { unitObj } = await this.bob.getUnitInfo({ unit })

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['deposit_' + this.id]).to.deep.equalInAnyOrder({
			amount: this.deposit_tokens2,
			stable_amount: this.deposit_stable_tokens,
			protection: this.protection,
			owner: this.aliceAddress,
			ts: this.ts,
		})
		expect(vars['deposit_' + this.id + '_force_close']).to.deep.equalInAnyOrder({
			ts: unitObj.timestamp,
			closer: this.bobAddress,
			protection_ratio: this.protection_ratio,
			interest: this.interest,
		})
		expect(vars['supply']).to.be.equal(this.supply)
		expect(vars['last_force_closed_protection_ratio']).to.be.undefined

		// Bob gets back his overpayment as change
		const { unitObj: responseUnitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(responseUnitObj)).to.deep.equalInAnyOrder([{
			address: this.bobAddress,
			asset: this.asset_stable,
			amount: overpayment,
		}])
	})


	it("Charlie challenges the close indicating Bob's deposit", async () => {
		const { unit, error } = await this.charlie.triggerAaWithData({
			toAddress: this.deposit_aa,
			amount: 1e4,
			data: {
				id: this.id,
				weaker_id: this.bob_id,
				challenge_force_close: 1,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.error).to.be.undefined

		const { vars } = await this.bob.readAAStateVars(this.deposit_aa)
		console.log(vars)
		expect(vars['deposit_' + this.id]).to.deep.equalInAnyOrder({
			amount: this.deposit_tokens2,
			stable_amount: this.deposit_stable_tokens,
			protection: this.protection,
			owner: this.aliceAddress,
			ts: this.ts,
		})
		expect(vars['deposit_' + this.id + '_force_close']).to.be.undefined
		expect(vars['supply']).to.be.equal(this.supply)
		expect(vars['last_force_closed_protection_ratio']).to.be.undefined

		const new_stable_amount = this.deposit_stable_tokens + this.interest
		const reporter_amount = Math.ceil(this.reporter_share * new_stable_amount)
		const refund_amount = new_stable_amount - reporter_amount

		await this.network.witnessUntilStable(response.response_unit)
		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset_stable,
				address: this.bobAddress,
				amount: refund_amount,
			},
			{
				asset: this.asset_stable,
				address: this.charlieAddress,
				amount: reporter_amount,
			},
		])
	})


	after(async () => {
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
