const token = 'cfut_cctD3zfr7unNFCKbYwx40dE3crJ74i6N1X0IjBw9754606de';
const zoneId = '90c3f249f1f5a2ce599b46d105aa9907';

const toDelete = [
  '39ca6a842629d5aa224b0310b17a7b16', // *.morline.space A
  '0cd423d6b209404ba260d779cd97db7f', // *.morline.space A
  '377c78c98eb466693c9eb4a9eb5b55ec', // morline.space A
  '9db3c499eded7f4ebddcfa12f1612a15', // morline.space A
  '6ab8c3652cd0972fbf02eb767ed185cf', // www.morline.space A
  'c52de34229818cacd7e3e6c85964a1db', // www.morline.space A
  'aa7ab70b6296d4cd9cdfe7359210b567'  // _domainconnect CNAME
];

async function clean() {
  for (const id of toDelete) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const d = await res.json();
    console.log(`Deleted record ${id}:`, d.success);
  }

  console.log('\nFetching remaining DNS records...');
  const listRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=100`, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const listData = await listRes.json();
  if (listData.result) {
    for (const r of listData.result) {
      console.log(`Remaining -> ${r.type} | ${r.name} -> ${r.content}`);
    }
  }
}

clean();
