import React, {useState, useEffect} from 'react'
import axios from 'axios'
import './styles.css'

export default function App(){
  const [accounts, setAccounts] = useState([])
  const [selected, setSelected] = useState(null)
  const [fileUrl, setFileUrl] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [accountDetails, setAccountDetails] = useState(null)
  const [message, setMessage] = useState('')

  const backend = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'

  useEffect(()=>{ fetchAccounts() },[])
  useEffect(()=>{ fetchPublicUrl() },[])

  async function fetchAccounts(){
    try{
      const res = await axios.get(`${backend}/accounts`)
      setAccounts(res.data)
      const page = res.data.find(a => a.provider === 'facebook_page')
      if(page) setSelected(page.id)
      else if(res.data[0]) setSelected(res.data[0].id)
    }catch(e){console.error(e)}
  }

  async function fetchPublicUrl(){
    try{
      const res = await axios.get(`${backend}/public_url`)
      const pu = res.data.public_url || ''
      setPublicUrl(pu)
      if(pu) setFileUrl(`${pu}/uploads/`)
    }catch(e){console.error('public url fetch failed', e)}
  }

  function connectFacebook(){ window.location.href = `${backend}/auth/facebook` }

  async function submitPost(e){
    e.preventDefault()
    if(!selected) return alert('choose account')
    try{
      const res = await axios.post(`${backend}/posts`, { accountId: selected, file_url: fileUrl, message })
      alert('posted: ' + JSON.stringify(res.data))
    }catch(err){
      console.error(err?.response?.data || err.message)
      alert('error: ' + JSON.stringify(err?.response?.data || err.message))
    }
  }

  async function uploadFile(e){
    const f = e.target.files && e.target.files[0]; if(!f) return;
    try{
      setUploading(true)
      const form = new FormData(); form.append('file', f);
      const res = await axios.post(`${backend}/upload`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      })
      if(res.data && res.data.url) setFileUrl(res.data.url)
    }catch(err){ console.error('upload failed', err?.response?.data || err.message); alert('upload failed') }
    finally{ setUploading(false) }
  }

  useEffect(()=>{
    if(!selected) return setAccountDetails(null)
    async function fetchAccountDetails(){
      try{
        const res = await axios.get(`${backend}/accounts/${selected}`)
        setAccountDetails(res.data)
      }catch(e){ console.error('account details failed', e?.response?.data || e.message); setAccountDetails(null) }
    }
    fetchAccountDetails()
  },[selected])

  return (
    <div className="container">
      <div className="card">
        <div className="row">
          <div className="col">
            <h1>Posty</h1>
            <div className="small">Simple social uploader — connect a Facebook Page and post a file</div>
          </div>
          <div className="actions">
            <button onClick={connectFacebook}>Connect Facebook</button>
            <button className="ghost" onClick={fetchAccounts}>Refresh</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Connected accounts</h2>
        <ul className="accounts-list">
          {accounts.length === 0 && <li className="small">No accounts connected</li>}
          {accounts.map(a => (
            <li key={a.id}>
              <div>
                <strong>{a.display_name || `${a.provider} - ${a.provider_user_id}`}</strong>
                <div className="small">{a.provider}</div>
              </div>
              <div>
                <button className="ghost" onClick={()=>setSelected(a.id)}>Select</button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Upload & Post</h2>
        {accountDetails && (
          <div className="selected-account card" style={{padding:12}}>
            {accountDetails.picture ? <img src={accountDetails.picture} alt="avatar" className="avatar" /> : <div style={{width:48,height:48,borderRadius:999,background:'#eef2ff'}} />}
            <div>
              <div style={{fontWeight:600}}>{accountDetails.display_name || accountDetails.provider_user_id}</div>
              <div className="small">{accountDetails.provider}</div>
            </div>
          </div>
        )}

        <form onSubmit={submitPost}>
          <div style={{marginBottom:12}}>
            <label>Account</label>
            <select value={selected||''} onChange={e=>setSelected(e.target.value)}>
              <option value="">-- choose --</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.display_name || `${a.provider} - ${a.provider_user_id}`}</option>)}
            </select>
          </div>

          <div style={{marginBottom:12}}>
            <label>Upload file</label>
            <input type="file" onChange={uploadFile} />
            {uploading ? <div className="small">Uploading…</div> : null}
            {uploading && <div className="progress" style={{marginTop:8}}><div className="progress-bar" style={{width: `${uploadProgress}%`}}/></div>}
          </div>

          <div style={{marginBottom:12}}>
            <label>File public URL</label>
            <input value={fileUrl} onChange={e=>setFileUrl(e.target.value)} placeholder={publicUrl? `${publicUrl}/uploads/...` : 'https://your-tunnel/uploads/...'} />
          </div>

          <div style={{marginBottom:12}}>
            <label>Message</label>
            <input value={message} onChange={e=>setMessage(e.target.value)} />
          </div>

          <div className="flex-between">
            <div className="notice">Preview: <span className="small">{fileUrl || 'no file selected'}</span></div>
            <div>
              <button type="submit" disabled={uploading}>Post</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
