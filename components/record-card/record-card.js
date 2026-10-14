Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
  },

  methods: {
    onTap: function () {
      this.triggerEvent('itemtap', { id: this.data.item.id })
    },
    onSettle: function () {
      this.triggerEvent('settle', {
        id: this.data.item.id,
        settled: !this.data.item.isSettled,
      })
    },
  },
})
