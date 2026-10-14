const { listAllRecords, listContacts, setRecordSettled } = require('../../utils/db')
const { formatAmount, toNumber, shortDate } = require('../../utils/format')

function toRecordVM(record) {
  const direction = record.direction === 'out' ? 'out' : 'in'
  const isSettled = !!record.is_settled

  return {
    id: record.id,
    name: record.contact_name || '未署名',
    direction: direction,
    directionText: direction === 'in' ? '收礼' : '送礼',
    isSettled: isSettled,
    statusText: direction === 'in' ? (isSettled ? '已还' : '待还') : (isSettled ? '已回' : '待回'),
    amount: toNumber(record.amount),
    amountText: formatAmount(record.amount),
    eventType: record.event_type || '',
    dateText: shortDate(record.happened_on),
    hasPhoto: !!record.photo_path,
    note: record.note || '',
  }
}

/**
 * 按人归集人情往来
 * net = 收礼合计 - 送礼合计
 *   net > 0 → 对方给的多，我欠 TA 人情
 *   net < 0 → 我给的多，TA 欠我人情
 */
function buildPeople(records, contacts) {
  const relationMap = {}
  ;(contacts || []).forEach(function (item) {
    if (item && item.name) relationMap[item.name] = item.relation || ''
  })

  const map = {}

  ;(records || []).forEach(function (record) {
    const name = (record.contact_name || '').trim() || '未署名'

    if (!map[name]) {
      map[name] = {
        name: name,
        initial: name.slice(0, 1),
        relation: relationMap[name] || '',
        count: 0,
        pending: 0,
        inTotal: 0,
        outTotal: 0,
        records: [],
        open: false,
      }
    }

    const person = map[name]
    const amount = toNumber(record.amount)
    person.count += 1
    if (!record.is_settled) person.pending += 1
    if (record.direction === 'out') person.outTotal += amount
    else person.inTotal += amount

    person.records.push(toRecordVM(record))
  })

  const people = Object.keys(map).map(function (key) {
    const person = map[key]
    const net = person.inTotal - person.outTotal
    person.net = net
    person.netAbsText = formatAmount(Math.abs(net))
    person.inTotalText = formatAmount(person.inTotal)
    person.outTotalText = formatAmount(person.outTotal)
    person.netLabel = net > 0 ? '我欠 TA' : net < 0 ? 'TA 欠我' : '两清'
    return person
  })

  people.sort(function (a, b) {
    return Math.abs(b.net) - Math.abs(a.net)
  })

  return people
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    people: [],
    summary: {
      peopleCount: 0,
      recordCount: 0,
      oweText: '0',
      backText: '0',
    },
  },

  onShow: function () {
    this.bootstrap()
  },

  bootstrap: function () {
    const page = this
    const app = getApp()
    app.ready().then(function (session) {
      if (!session) {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      page.load()
    })
  },

  load: function () {
    const page = this
    this.setData({ loading: true, errorMsg: '' })

    // 按人汇总必须看到全部流水，否则净额会算错且毫无提示
    Promise.all([listAllRecords(), listContacts()])
      .then(function (result) {
        const records = result[0] || []
        const contacts = result[1] || []
        const people = buildPeople(records, contacts)

        let oweTotal = 0
        let backTotal = 0
        people.forEach(function (person) {
          if (person.net > 0) oweTotal += person.net
          else backTotal += -person.net
        })

        page.setData({
          loading: false,
          people: people,
          summary: {
            peopleCount: people.length,
            recordCount: records.length,
            oweText: formatAmount(oweTotal),
            backText: formatAmount(backTotal),
          },
        })
      })
      .catch(function (err) {
        page.setData({ loading: false, errorMsg: (err && err.message) || '汇总失败，请下拉重试' })
      })
  },

  onTogglePerson: function (e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!this.data.people[index]) return
    const patch = {}
    patch['people[' + index + '].open'] = !this.data.people[index].open
    this.setData(patch)
  },

  onRecordTap: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id })
  },

  onSettle: function (e) {
    const page = this
    const id = e.detail.id
    const settled = e.detail.settled

    setRecordSettled(id, settled)
      .then(function () {
        wx.showToast({ title: settled ? '已划掉' : '已恢复', icon: 'none' })
        page.load()
      })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' })
      })
  },

  onPullDownRefresh: function () {
    this.load()
    setTimeout(function () {
      wx.stopPullDownRefresh()
    }, 700)
  },
})
